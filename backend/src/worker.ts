import { DelayedError, Worker } from "bullmq";
import nodemailer from "nodemailer";
import { config } from "./config";
import { prisma } from "./db";
import { EMAIL_QUEUE, EmailJob } from "./queue";
import { redis } from "./redis";
import { indexEmail } from "./search";
import { notifyRateLimit } from "./slack";

const transporter = (async () => {
  const credentials = config.ETHEREAL_USER && config.ETHEREAL_PASSWORD
    ? { user: config.ETHEREAL_USER, pass: config.ETHEREAL_PASSWORD }
    : await nodemailer.createTestAccount();
  if (!config.ETHEREAL_USER || !config.ETHEREAL_PASSWORD) {
    console.log(`Created temporary Ethereal account ${credentials.user}`);
  }
  return nodemailer.createTransport({
    host: config.ETHEREAL_HOST,
    port: config.ETHEREAL_PORT,
    secure: config.ETHEREAL_PORT === 465,
    auth: credentials
  });
})();

const reservationScript = `
local count = tonumber(redis.call("GET", KEYS[1]) or "0")
local limit = tonumber(ARGV[1])
local now = tonumber(ARGV[2])
local windowEnd = tonumber(ARGV[3])
local configuredLimit = tonumber(redis.call("GET", KEYS[3]) or limit)
if limit < configuredLimit then
  configuredLimit = limit
  redis.call("SET", KEYS[3], configuredLimit, "EX", 7200)
elseif not redis.call("GET", KEYS[3]) then
  redis.call("SET", KEYS[3], configuredLimit, "EX", 7200)
end
limit = configuredLimit
local notified = redis.call("GET", KEYS[2])
if count >= limit then
  if not notified then
    redis.call("SET", KEYS[2], "1", "EX", 7200)
    return {0, windowEnd, 1}
  end
  return {0, windowEnd, 0}
end
redis.call("INCR", KEYS[1])
redis.call("EXPIRE", KEYS[1], 7200)
return {1, now, 0}
`;

const worker = new Worker<EmailJob>(EMAIL_QUEUE, async (job) => {
  const email = await prisma.email.findUnique({ where: { id: job.data.emailId } });
  if (!email || email.status === "sent" || email.status === "failed") return;

  const now = Date.now();
  const windowStart = Math.floor(now / 3_600_000) * 3_600_000;
  const windowEnd = windowStart + 3_600_000;
  const senderKey = Buffer.from(email.sender).toString("hex");
  const keys = [
    `email-rate:${senderKey}:${windowStart}`,
    `email-rate-notified:${senderKey}:${windowStart}`,
    `email-rate-limit:${senderKey}:${windowStart}`
  ];
  const result = await redis.eval(
    reservationScript,
    keys.length,
    ...keys,
    String(Math.min(email.hourlyLimit, config.MAX_EMAILS_PER_HOUR_PER_SENDER)),
    String(now),
    String(windowEnd)
  ) as [number, number, number];

  if (Number(result[0]) === 0) {
    if (Number(result[2]) === 1) {
      notifyRateLimit(email.userId, email.sender).catch((error: Error) => {
        console.error("Slack rate-limit notification failed:", error.message);
      });
    }
    const delayedUntil = new Date(Number(result[1]));
    const updated = await prisma.email.update({
      where: { id: email.id },
      data: { status: "scheduled", scheduledAt: delayedUntil }
    });
    try {
      await indexEmail(updated);
    } catch (error) {
      console.error("Could not update Elasticsearch document:", error);
    }
    await job.moveToDelayed(Number(result[1]), job.token);
    throw new DelayedError();
  }

  await prisma.email.update({
    where: { id: email.id },
    data: { status: "sending", attempts: { increment: 1 }, error: null }
  });

  try {
    const info = await (await transporter).sendMail({
      from: email.sender,
      to: email.recipient,
      subject: email.subject,
      text: email.body
    });
    console.log(`Ethereal accepted ${email.id}; preview: ${nodemailer.getTestMessageUrl(info) ?? "unavailable"}`);
    const sent = await prisma.email.update({
      where: { id: email.id },
      data: { status: "sent", sentAt: new Date(), error: null }
    });
    try {
      await indexEmail(sent);
    } catch (error) {
      console.error("Could not update Elasticsearch document:", error);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown SMTP error";
    const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
    await prisma.email.update({
      where: { id: email.id },
      data: { status: isFinalAttempt ? "failed" : "scheduled", error: message }
    });
    if (isFinalAttempt) {
      const failed = await prisma.email.findUniqueOrThrow({ where: { id: email.id } });
      try {
        await indexEmail(failed);
      } catch (indexError) {
        console.error("Could not index failed email:", indexError);
      }
    }
    throw error;
  }
}, {
  connection: redis,
  concurrency: config.WORKER_CONCURRENCY,
  limiter: { max: 1, duration: config.MIN_SEND_DELAY_MS }
});

worker.on("failed", (job, error) => {
  console.error(`Email job ${job?.id ?? "unknown"} failed:`, error.message);
});

worker.on("error", (error) => {
  console.error("BullMQ worker error:", error);
});

console.log(`Email worker started with concurrency ${config.WORKER_CONCURRENCY}`);
