#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { loadSignedAgentCard } from "@red-cup-engineering/a2a-contracted-agent-service/signed-agent-card";
import { deliverActivity } from "@red-cup-engineering/activitypub-services-section";
import { createActivityPubR2Custody } from "@red-cup-engineering/activitypub-services-section/r2-custody";
import { serveActivityPubProvider } from "@red-cup-engineering/activitypub-services-section/server";
import { extractRmnActivity, projectRmnActivity } from "@red-cup-engineering/activitypub-services-section/rmn-activity";
import { extractRmnPart, parseA2aMessage } from "@red-cup-engineering/a2a-rmn-part-service";
import { executeA2aMessage, operationFromBytes } from "./a2a-executor.mjs";
import { markInductionResponseDelivered } from "./induction-saga.mjs";
import { createGithubInductionProductionRuntime } from "./github-induction-production-runtime.mjs";

export async function serveGithubSoftwareInductionActivityPub(options = {}) {
  const origin = String(options.origin ?? process.env.ACTIVITYPUB_ORIGIN ?? "").replace(/\/$/u, "");
  if (!origin) throw new Error("ACTIVITYPUB_ORIGIN is required");
  const identifier = options.identifier ?? process.env.ACTIVITYPUB_IDENTIFIER ?? "github-software-induction-service";
  const actor = `${origin}/actors/${identifier}`;
  const custody = options.custody ?? createActivityPubR2Custody({ actor: identifier });
  const testOnlyInProcess = options.testOnlyInProcess === true;
  const queue = options.queue;
  const operationStore = options.operationStore;
  if (!testOnlyInProcess && (!queue || typeof queue.consume !== "function")) {
    throw new Error("GitHub induction ActivityPub service requires an injected durable queue with consume");
  }
  if (!testOnlyInProcess && (!operationStore || typeof operationStore.get !== "function" || typeof operationStore.compareAndSet !== "function")) {
    throw new Error("GitHub induction ActivityPub service requires an injected durable operation store");
  }
  if (options.executorOptions?.operationStore !== undefined && options.executorOptions.operationStore !== operationStore) {
    throw new Error("GitHub induction executorOptions.operationStore must be the injected durable operation store");
  }
  const executorOptions = Object.freeze({ ...options.executorOptions, operationStore });
  const discovery = options.agentCardDocuments ?? await loadSignedAgentCard({
    origin,
    cardPath: resolve(import.meta.dirname, "../content/agent-cards/github-software-induction-service.json"),
  });
  const fetchActor = options.fetch ?? fetch;
  let running;
  async function receive(arrival) {
    const activity = arrival?.jsonLd;
    const sender = typeof activity?.actor === "string" ? activity.actor : null;
    if (!sender || sender === actor) return;
    const projection = extractRmnActivity(activity, { expectedActor: sender, expectedRecipient: actor });
    const responseMessage = await (options.execute ?? executeA2aMessage)(projection.a2aMessage, executorOptions);
    const bytes = extractRmnPart(parseA2aMessage(responseMessage).parts).bytes;
    const response = projectRmnActivity({
      type: "Accept", origin, identifier, recipient: sender, objectBytes: bytes,
      a2aMessage: responseMessage, a2aRole: "ROLE_AGENT", agentCard: actor,
      eventTime: new Date().toISOString(),
    });
    const actorResponse = await fetchActor(sender, { headers: { accept: "application/activity+json" } });
    if (!actorResponse.ok) throw new Error(`ActivityPub sender actor lookup failed with ${actorResponse.status}`);
    const senderDocument = await actorResponse.json();
    const inbox = typeof senderDocument?.inbox === "string" ? senderDocument.inbox : senderDocument?.inbox?.id;
    if (typeof inbox !== "string" || !inbox) throw new Error("ActivityPub sender actor exposes no inbox");
    await (options.deliver ?? deliverActivity)(running.provider, { activity: response, recipient: sender, inbox });
    await markInductionResponseDelivered(operationFromBytes(bytes).request, executorOptions);
  }
  running = await (options.serve ?? serveActivityPubProvider)({
    origin, identifier, actorName: "GitHub Software Induction Service",
    summary: "Verifies and publishes GitHub software transitions carried as A2A RMN inside ActivityPub CloudEvents.",
    keyPath: options.keyPath ?? process.env.ACTIVITYPUB_KEYS_PATH,
    kv: custody.kv, inbox: custody.inbox, queue,
    hostname: options.hostname ?? process.env.HOST ?? "0.0.0.0",
    port: Number(options.port ?? process.env.PORT ?? "8080"),
    bearerToken: options.bearerToken ?? randomBytes(32).toString("base64url"),
    testOnlyInProcess,
    onActivity: receive, listOutbox: async () => ({ items: [] }),
    ...(typeof queue?.consume === "function" ? {
      workerRoute: { path: "/_private/github-induction-worker", consume: (request) => queue.consume(request) },
    } : {}),
    wellKnownResources: {
      "/.well-known/agent-card.json": discovery.card,
      "/.well-known/jwks.json": discovery.jwks,
    },
  });
  if (queue !== undefined) {
    void running.provider.federation.startQueue(undefined).catch((error) => {
      process.stderr.write(`ActivityPub queue worker stopped: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    });
  }
  return running;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  Promise.resolve().then(() => serveGithubSoftwareInductionActivityPub(createGithubInductionProductionRuntime())).then(() => {
    const origin = String(process.env.ACTIVITYPUB_ORIGIN ?? "").replace(/\/$/u, "");
    process.stdout.write(`${origin}/actors/${process.env.ACTIVITYPUB_IDENTIFIER ?? "github-software-induction-service"}\n`);
  }).catch((error) => { process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`); process.exitCode = 1; });
}
