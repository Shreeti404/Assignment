import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");
const dockerCandidates = process.platform === "win32"
  ? [
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe",
    "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.cmd"
  ]
  : [];
const dockerCommand = process.platform === "win32"
  ? (dockerCandidates.find(existsSync) ?? "docker")
  : "docker";

function fail(message) {
  console.error(`\nSetup failed: ${message}`);
  process.exit(1);
}

if (!existsSync(envPath)) {
  const generated = readFileSync(examplePath, "utf8")
    .replace("replace-with-a-long-random-secret", randomBytes(32).toString("hex"))
    .replace("replace-with-32-or-more-random-characters", randomBytes(32).toString("hex"));
  writeFileSync(envPath, generated, { flag: "wx" });
  console.log("Created .env with local development secrets.");
}

const childEnv = { ...process.env };
for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
  const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
  if (match) childEnv[match[1]] = match[2].trim();
}

const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  const resolvedCommand = command === "docker" ? dockerCommand : command;
  const result = spawnSync(resolvedCommand, args, {
    cwd: root,
    env: childEnv,
    stdio: "inherit",
    shell: process.platform === "win32" && resolvedCommand.toLowerCase().endsWith(".cmd")
  });
  if (result.error) fail(result.error.message);
  if (result.status !== 0) fail(`${resolvedCommand} ${args.join(" ")} exited with status ${result.status}`);
}

function commandSucceeded(command, args) {
  const resolvedCommand = command === "docker" ? dockerCommand : command;
  const result = spawnSync(resolvedCommand, args, {
    cwd: root,
    env: childEnv,
    stdio: "ignore",
    shell: process.platform === "win32" && resolvedCommand.toLowerCase().endsWith(".cmd")
  });
  return result.status === 0;
}

if (!existsSync(path.join(root, "node_modules"))) {
  run(npm, ["install"]);
}

run("docker", ["compose", "up", "-d"]);

for (const [service, args] of [
  ["postgres", ["exec", "-T", "postgres", "pg_isready", "-U", "scheduler", "-d", "scheduler"]],
  ["redis", ["exec", "-T", "redis", "redis-cli", "ping"]]
]) {
  let ready = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (commandSucceeded("docker", ["compose", ...args])) {
      ready = true;
      break;
    }
    await delay(2000);
  }
  if (!ready) fail(`${service} did not become ready. Check Docker Desktop and docker compose logs.`);
}

let elasticsearchReady = false;
for (let attempt = 0; attempt < 45; attempt += 1) {
  try {
    const response = await fetch("http://localhost:9200/_cluster/health");
    if (response.ok) {
      elasticsearchReady = true;
      break;
    }
  } catch {
    // Elasticsearch is still starting.
  }
  await delay(2000);
}
if (!elasticsearchReady) fail("Elasticsearch did not become ready. Check docker compose logs.");

run(npm, ["run", "db:generate"]);
run(npm, ["run", "db:migrate", "--workspace", "backend"]);
console.log("\nSetup complete. Start the app with the VS Code task 'Run scheduler'.");
if (!childEnv.GOOGLE_CLIENT_ID || !childEnv.GOOGLE_CLIENT_SECRET) {
  console.log("Google sign-in needs OAuth credentials in .env before dashboard login will work.");
}
if (!childEnv.SLACK_CLIENT_ID || !childEnv.SLACK_CLIENT_SECRET) {
  console.log("Slack notifications stay disabled until Slack OAuth credentials are added to .env.");
}
