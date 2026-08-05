import assert from "node:assert/strict";
import test from "node:test";
import { serveGithubSoftwareInductionActivityPub } from "../src/serve-activitypub.mjs";

test("public provider face is ActivityPub custody rather than a public A2A listener", async () => {
  let admitted;
  let consumed = 0;
  const running = await serveGithubSoftwareInductionActivityPub({
    origin: "https://github-induction.example",
    custody: { kv: {}, inbox: {} },
    queue: { consume: async (request) => { consumed += 1; assert.equal(request.headers.get("authorization"), "Bearer queue-owns-this"); return new Response(null, { status: 204 }); } },
    operationStore: { get: async () => null, compareAndSet: async () => ({ version: 1 }) },
    agentCardDocuments: { card: { signatures: [{ protected: "signed" }] }, jwks: { keys: [] } },
    serve: async (options) => {
      admitted = options;
      return { provider: { federation: { startQueue: async () => {} } } };
    },
  });
  assert.ok(running.provider);
  assert.equal(admitted.identifier, "github-software-induction-service");
  assert.equal(admitted.hostname, "0.0.0.0");
  assert.deepEqual(admitted.wellKnownResources["/.well-known/agent-card.json"].signatures, [{ protected: "signed" }]);
  assert.equal(Object.hasOwn(admitted.wellKnownResources, "/a2a/jsonrpc"), false);
  assert.equal(admitted.workerRoute.path, "/_private/github-induction-worker");
  const workerResponse = await admitted.workerRoute.consume(new Request("https://github-induction.example/_private/github-induction-worker", { method: "POST", headers: { authorization: "Bearer queue-owns-this" } }));
  assert.equal(workerResponse.status, 204);
  assert.equal(consumed, 1);
});

test("production ActivityPub induction fails closed without durable queue or operation store", async () => {
  const common = { origin: "https://github-induction.example", custody: { kv: {}, inbox: {} } };
  await assert.rejects(() => serveGithubSoftwareInductionActivityPub(common), /durable queue/);
  await assert.rejects(() => serveGithubSoftwareInductionActivityPub({ ...common, queue: { consume: async () => {} } }), /operation store/);
});
