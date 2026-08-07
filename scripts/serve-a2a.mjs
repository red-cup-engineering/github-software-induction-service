#!/usr/bin/env node
import { resolve } from "node:path";
import { serveContractedAgent } from "@red-cup-engineering/a2a-contracted-agent-service";
const root = resolve(import.meta.dirname, "..");
serveContractedAgent({
  port: Number(process.env.PORT ?? "8080"), host: process.env.HOST ?? "0.0.0.0", baseUrl: process.env.BASE_URL,
  agentCard: resolve(root, "content/agent-cards/github-software-induction-service.json"),
  executor: process.execPath, executorArgs: [resolve(root, "bin/execute-a2a-message.mjs")],
}).then(({ server, baseUrl }) => {
  process.stdout.write(`${baseUrl}\n`);
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGINT", stop); process.once("SIGTERM", stop);
}).catch((error) => { process.stderr.write(`${error.stack ?? error.message}\n`); process.exitCode = 1; });
