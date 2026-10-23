# ReachInbox email scheduler

A TypeScript email scheduling app with an Express API, PostgreSQL persistence, BullMQ/Redis workers, Elasticsearch search, Google sign-in, Slack rate-limit notifications, and a React dashboard.

## Requirements

- Node.js 20+
- Docker Desktop
- Google OAuth credentials
- Slack app credentials (optional; needed for Slack notifications)
- Optional Ethereal SMTP credentials (a temporary test account is created automatically if omitted)

## Run locally

In VS Code, open this folder and allow the automatic **Run scheduler** task when prompted. It creates `.env` with local secrets if needed, starts Docker services, installs dependencies if needed, applies the database migration, then starts the API, worker, and dashboard. Docker Desktop must be running. To start it manually, use **Tasks: Run Task → Run scheduler**.

To start manually, copy `.env.example` to `.env`, then set Google credentials. The setup task can generate local session/encryption secrets; the worker creates an Ethereal test account automatically if SMTP credentials are not set. Add Slack credentials if you want to verify Slack notifications.
2. Start PostgreSQL, Redis, and Elasticsearch:

   ```sh
   docker compose up -d
   ```

3. Install packages, generate Prisma Client, and apply the schema:

   ```sh
   npm install
   npm run db:generate
   npm run db:migrate --workspace backend
   ```

4. Run the API, worker, and dashboard:

   ```sh
   npm run dev
   ```

   The dashboard is at `http://localhost:5173`, the API is at `http://localhost:4000`, and the BullMQ dashboard is at `http://localhost:4000/admin/queues` after signing in.

For production, build with `npm run build`, then run `npm run start --workspace backend` and `npm run worker --workspace backend` as separate managed processes. Serve the frontend build from a static web server and configure its origin and API routing accordingly.

## OAuth and SMTP setup

- **Google:** Create a Google OAuth web application. Add `http://localhost:4000/auth/google/callback` as an authorized redirect URI and put its client ID and secret in `.env`. Login is disabled until configured.
- **Slack:** Create a Slack app, enable OAuth, add `http://localhost:4000/auth/slack/callback` as a redirect URI, and grant the bot scopes `chat:write` and `im:write`. Set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, and `SLACK_CALLBACK_URL`. A user connects from the dashboard; the OAuth token is encrypted at rest. Disconnecting removes the stored token.
- **Ethereal:** Create a test account at [ethereal.email](https://ethereal.email/create), then set `ETHEREAL_USER` and `ETHEREAL_PASSWORD`. Ethereal captures test mail rather than delivering to a real recipient; its preview link is printed by the worker.

## Architecture and guarantees

- **Persistence:** PostgreSQL is the system of record. Each recipient has one durable email row, and Redis persistence is enabled in Docker Compose. BullMQ delayed jobs survive API/worker process restarts. API startup reconciles scheduled/sending database rows back into the queue; retries use a stable BullMQ job ID, and repeated requests use an `Idempotency-Key` plus a unique recipient-derived key.
- **Scheduling:** `POST /api/emails/schedule` saves each recipient and adds a delayed BullMQ job based on `startAt` and `delayBetweenEmailsMs`. There are no cron jobs. The API requires an `Idempotency-Key` header.
- **Concurrency and send spacing:** Worker concurrency is configured by `WORKER_CONCURRENCY`. BullMQ's shared worker limiter allows one send per `MIN_SEND_DELAY_MS` across worker instances. A campaign's chosen interval also spaces the individual scheduled times.
- **Hourly cap:** `MAX_EMAILS_PER_HOUR_PER_SENDER` is the workspace maximum; the compose form may request a lower cap. A Redis Lua script atomically reserves each sender's hourly allowance, shared by all workers. A job over the cap is moved to the next hour, not failed. A Redis notification key ensures a single limit-hit notification per sender per window. If Slack is not connected, sending continues without a notification. If Slack is connected but the API call fails, the error is logged and does not fail email delivery.
- **Search and queue visibility:** Email records are indexed in Elasticsearch and can be searched by recipient, sender, subject, or body using the dashboard search. Bull Board exposes live queue status under `/admin/queues` and requires authentication.
- **SMTP delivery and retries:** BullMQ retries transient delivery errors up to five times with exponential backoff; terminal failures are stored and shown in the Sent view. SMTP delivery and a database update cannot be made atomic. If SMTP accepts a message and the worker crashes before persisting success, a retry can produce a duplicate. Strict exactly-once delivery requires SMTP/provider idempotency support for that narrow failure case.

## API

- `GET /api/me` — current signed-in user
- `POST /auth/logout` — end the session
- `POST /api/emails/schedule` — schedule a batch (`sender`, `subject`, `body`, ISO `startAt`, optional `delayBetweenEmailsMs`, optional `hourlyLimit`, and `recipients[]`)
- `GET /api/emails?status=scheduled|sent|failed&q=...` — list or search the signed-in user's emails
- `GET /auth/slack` and `DELETE /api/slack` — connect/disconnect Slack

## Assignment feature checklist

- Backend: Express + TypeScript, PostgreSQL/Prisma, delayed BullMQ jobs, persistent job IDs, SMTP delivery through Ethereal, configurable concurrency and send spacing, Redis hourly limits, Slack OAuth notifications, Elasticsearch indexing/search, authenticated Bull Board.
- Frontend: React + TypeScript, Google OAuth login, user profile/logout, Slack connect/disconnect, compose modal, CSV/text address extraction, schedule controls, scheduled/sent lists, search, loading/empty/error states.
- Demo: show Google login, connect Slack if configured, schedule multiple addresses, inspect scheduled/sent records and queue dashboard, then restart the worker/API while future jobs remain queued. To demonstrate rate limiting, temporarily set a small `MAX_EMAILS_PER_HOUR_PER_SENDER`, use a connected Slack workspace, and schedule more messages than the cap. Restore the normal value afterward.

The provided Figma file can be used to tune visual details; compare the responsive dashboard against the design before submission.
