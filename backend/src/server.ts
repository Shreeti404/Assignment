import { randomBytes, createHash } from "node:crypto";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import session from "express-session";
import connectPgSimple from "connect-pg-simple";
import passport from "passport";
import { z } from "zod";
import { ExpressAdapter } from "@bull-board/express";
import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { config } from "./config";
import { prisma } from "./db";
import { emailQueue } from "./queue";
import { requireAuth } from "./middleware";
import { indexEmails, searchEmails } from "./search";
import { encryptToken } from "./tokenCrypto";
import "./auth";

const app = express();
const PgSession = connectPgSimple(session);

app.use(cors({ origin: config.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: "2mb" }));
app.use(session({
  store: new PgSession({
    conString: config.DATABASE_URL,
    createTableIfMissing: true
  }),
  secret: config.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));
app.use(passport.initialize());
app.use(passport.session());

const boardAdapter = new ExpressAdapter();
boardAdapter.setBasePath("/admin/queues");
createBullBoard({
  queues: [new BullMQAdapter(emailQueue)],
  serverAdapter: boardAdapter
});
app.use("/admin/queues", requireAuth, boardAdapter.getRouter());

const asyncRoute = (handler: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction) => {
    handler(req, res).catch(next);
  };

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/auth/google", (req, res, next) => {
  if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
    res.status(503).json({ error: "Google OAuth is not configured" });
    return;
  }
  passport.authenticate("google", { scope: ["profile", "email"] })(req, res, next);
});

app.get("/auth/google/callback",
  passport.authenticate("google", { failureRedirect: `${config.FRONTEND_URL}/?login=failed` }),
  (_req, res) => res.redirect(config.FRONTEND_URL)
);

app.get("/api/me", asyncRoute(async (req, res) => {
  if (!req.user) {
    res.json({ user: null });
    return;
  }
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: { id: true, name: true, email: true, avatar: true, slackToken: true }
  });
  res.json({ user: user ? { id: user.id, name: user.name, email: user.email, avatar: user.avatar, slackConnected: Boolean(user.slackToken) } : null });
}));

app.post("/auth/logout", (req, res, next) => {
  req.logout((error) => {
    if (error) return next(error);
    req.session.destroy((sessionError) => {
      if (sessionError) return next(sessionError);
      res.clearCookie("connect.sid");
      res.status(204).end();
    });
  });
});

app.get("/auth/slack", requireAuth, (req, res) => {
  if (!config.SLACK_CLIENT_ID || !config.SLACK_CLIENT_SECRET) {
    res.status(503).json({ error: "Slack OAuth is not configured" });
    return;
  }
  const state = randomBytes(24).toString("hex");
  req.session.slackState = state;
  const params = new URLSearchParams({
    client_id: config.SLACK_CLIENT_ID,
    scope: "chat:write,im:write",
    redirect_uri: config.SLACK_CALLBACK_URL,
    state
  });
  res.redirect(`https://slack.com/oauth/v2/authorize?${params}`);
});

app.get("/auth/slack/callback", requireAuth, asyncRoute(async (req, res) => {
  if (!req.query.code || req.query.state !== req.session.slackState) {
    res.status(400).send("Invalid Slack OAuth state");
    return;
  }
  delete req.session.slackState;
  const tokenResponse = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: config.SLACK_CLIENT_ID ?? "",
      client_secret: config.SLACK_CLIENT_SECRET ?? "",
      code: String(req.query.code),
      redirect_uri: config.SLACK_CALLBACK_URL
    })
  });
  const result = await tokenResponse.json() as {
    ok: boolean;
    error?: string;
    access_token?: string;
    authed_user?: { id?: string };
  };
  if (!result.ok || !result.access_token || !result.authed_user?.id) {
    throw new Error(`Slack authorization failed: ${result.error ?? "incomplete response"}`);
  }
  await prisma.user.update({
    where: { id: req.user!.id },
    data: {
      slackToken: encryptToken(result.access_token),
      slackUserId: result.authed_user.id
    }
  });
  res.redirect(`${config.FRONTEND_URL}?slack=connected`);
}));

app.delete("/api/slack", requireAuth, asyncRoute(async (req, res) => {
  await prisma.user.update({
    where: { id: req.user!.id },
    data: { slackToken: null, slackUserId: null }
  });
  res.status(204).end();
}));

const scheduleSchema = z.object({
  sender: z.string().email(),
  subject: z.string().min(1).max(998),
  body: z.string().min(1),
  startAt: z.string().datetime(),
  delayBetweenEmailsMs: z.number().int().min(0).max(86_400_000).default(0),
  hourlyLimit: z.number().int().positive().optional(),
  recipients: z.array(z.string().email()).min(1).max(5000)
});

app.post("/api/emails/schedule", requireAuth, asyncRoute(async (req, res) => {
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid schedule request", details: parsed.error.flatten() });
    return;
  }
  const requestKey = req.header("Idempotency-Key");
  if (!requestKey || requestKey.length > 200) {
    res.status(400).json({ error: "A valid Idempotency-Key header is required" });
    return;
  }

  const input = parsed.data;
  const startAt = new Date(input.startAt);
  if (startAt.getTime() < Date.now() - 60_000) {
    res.status(400).json({ error: "Start time must be in the future" });
    return;
  }

  const hourlyLimit = Math.min(
    input.hourlyLimit ?? config.MAX_EMAILS_PER_HOUR_PER_SENDER,
    config.MAX_EMAILS_PER_HOUR_PER_SENDER
  );
  const uniqueRecipients = [...new Set(input.recipients.map((address) => address.toLowerCase()))];
  const emailsToCreate = uniqueRecipients.map((recipient, index) => ({
    userId: req.user!.id,
    recipient,
    sender: input.sender.toLowerCase(),
    subject: input.subject,
    body: input.body,
    scheduledAt: new Date(startAt.getTime() + index * input.delayBetweenEmailsMs),
    status: "scheduled",
    idempotencyKey: createHash("sha256")
      .update(`${req.user!.id}:${requestKey}:${recipient}`)
      .digest("hex"),
    hourlyLimit
  }));
  const keys = emailsToCreate.map((email) => email.idempotencyKey);

  await prisma.email.createMany({ data: emailsToCreate, skipDuplicates: true });
  const records = await prisma.email.findMany({
    where: { userId: req.user!.id, idempotencyKey: { in: keys } },
    orderBy: { scheduledAt: "asc" }
  });

  await emailQueue.addBulk(records.map((email) => ({
    name: "send-email",
    data: { emailId: email.id, sender: email.sender, hourlyLimit: email.hourlyLimit },
    opts: {
      jobId: email.id,
      delay: Math.max(0, email.scheduledAt.getTime() - Date.now()),
      attempts: 5,
      backoff: { type: "exponential" as const, delay: 5000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail: false
    }
  })));
  await indexEmails(records);

  res.status(202).json({ scheduled: records.length, emails: records });
}));

app.get("/api/emails", requireAuth, asyncRoute(async (req, res) => {
  const status = req.query.status;
  const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
  if (status !== "scheduled" && status !== "sent" && status !== "failed") {
    res.status(400).json({ error: "status must be scheduled, sent, or failed" });
    return;
  }

  const ids = query ? await searchEmails(req.user!.id, query) : undefined;
  const emails = await prisma.email.findMany({
    where: {
      userId: req.user!.id,
      status: status === "scheduled" ? { in: ["scheduled", "sending"] } : status === "sent" ? { in: ["sent", "failed"] } : "failed",
      ...(ids ? { id: { in: ids } } : {})
    },
    orderBy: status === "scheduled" ? { scheduledAt: "asc" } : { createdAt: "desc" },
    take: 500
  });
  res.json({ emails });
}));

app.use((error: Error, _req: Request, res: Response, _next: NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error" });
});

async function startServer() {
  await prisma.$connect();
  const pending = await prisma.email.findMany({
    where: { status: { in: ["scheduled", "sending"] } },
    select: { id: true, sender: true, hourlyLimit: true, scheduledAt: true }
  });
  await emailQueue.addBulk(pending.map((email) => ({
    name: "send-email",
    data: { emailId: email.id, sender: email.sender, hourlyLimit: email.hourlyLimit },
    opts: {
      jobId: email.id,
      delay: Math.max(0, email.scheduledAt.getTime() - Date.now()),
      attempts: 5,
      backoff: { type: "exponential" as const, delay: 5000 },
      removeOnComplete: { age: 7 * 24 * 60 * 60 },
      removeOnFail: false
    }
  })));
  app.listen(config.PORT, () => {
    console.log(`API listening on http://localhost:${config.PORT}; recovered ${pending.length} pending email job(s)`);
  });
}

startServer().catch((error: Error) => {
  console.error("Could not start API:", error);
  process.exitCode = 1;
});
