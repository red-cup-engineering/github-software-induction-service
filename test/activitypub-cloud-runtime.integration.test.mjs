import assert from "node:assert/strict";
import test from "node:test";
import { createActivityPubProvider, importActorKeyPairs } from "@red-cup-engineering/activitypub-services-section";
import { generateActorKeyMaterial } from "@red-cup-engineering/activitypub-services-section/keys";
import { createCloudTasksMessageQueue, createGcsTransactionalOperationStore } from "@red-cup-engineering/gcloud-runtime-authorities-service";
import { executeInductionSaga, markInductionResponseDelivered } from "@red-cup-engineering/github-services-section/induction-saga";

const operation = `ni:///sha-256;${"A".repeat(43)}`;
const induction = Object.freeze({ id: operation, input: Object.freeze({ source: { repository: "union/root", commit: "a".repeat(40) }, target: { repository: "union/root", ref: "heads/main" } }) });
const response = (body, init = {}) => new Response(body === undefined ? null : JSON.stringify(body), init);
function memoryKv() {
  const values = new Map(), id = (key) => JSON.stringify(key);
  return {
    async get(key) { return values.get(id(key)); },
    async set(key, value) { values.set(id(key), value); },
    async delete(key) { values.delete(id(key)); },
    async cas(key, expected, value) {
      const identity = id(key), current = values.get(identity);
      if (JSON.stringify(current) !== JSON.stringify(expected)) return false;
      values.set(identity, value); return true;
    },
    async *list(prefix = []) {
      for (const [encoded, value] of values) {
        const key = JSON.parse(encoded);
        if (prefix.every((part, index) => key[index] === part)) yield { key, value };
      }
    },
  };
}

test("admitted Fedify work crosses custody-only Cloud Tasks, mutates GitHub once, and resumes a bound result", async () => {
  const custody = new Map(), tasks = [], generations = new Map(); let mutations = 0;
  const request = async (url, init = {}) => {
    if (url.includes("cloudtasks.googleapis.com")) {
      if (init.method === "POST") { tasks.push(JSON.parse(init.body).task); return response({}, { status: 200 }); }
      throw new Error(`unexpected Cloud Tasks request ${url}`);
    }
    const parsed = new URL(url), name = parsed.searchParams.get("name") ?? decodeURIComponent(parsed.pathname.split("/o/")[1] ?? "");
    if (!init.method) {
      const stored = generations.get(name);
      if (!stored) return response({}, { status: 404 });
      return parsed.searchParams.get("alt") === "media" ? response(stored.record) : response({ generation: stored.generation });
    }
    const expected = parsed.searchParams.get("ifGenerationMatch"), current = generations.get(name);
    if ((current?.generation ?? "0") !== expected) return response({}, { status: 412 });
    const generation = String(Number(current?.generation ?? "0") + 1);
    generations.set(name, { generation, record: JSON.parse(init.body) });
    return response({ generation });
  };
  const queue = createCloudTasksMessageQueue({
    project: "project", location: "us-central1", queue: "admitted", targetUrl: "https://worker.example/_private/github-induction-worker", serviceAccountEmail: "tasks@example.iam.gserviceaccount.com",
    custody: { async put({ ni, bytes }) { custody.set(ni, Buffer.from(bytes)); }, async get(ni) { const bytes = custody.get(ni); return bytes === undefined ? null : { bytes }; } },
    request, authenticate: async (workerRequest) => workerRequest.headers.get("authorization") === "Bearer verified",
  });
  const operationStore = createGcsTransactionalOperationStore({ bucket: "induction", request });
  const provider = createActivityPubProvider({
    origin: "https://worker.example/", identifier: "github-induction", actorName: "GitHub induction", summary: "integration test",
    keyPairs: await importActorKeyPairs(await generateActorKeyMaterial()), kv: memoryKv(), queue: { inbox: queue },
    onActivity: async () => executeInductionSaga(induction, {
      operationStore,
      induce: async () => ({ disposition: "bound", commit: `c${++mutations}` }),
    }),
    authorizeInbox: async () => false, listInbox: async () => ({ items: [], totalItems: 0 }), listOutbox: async () => ({ items: [] }),
  });
  const controller = new AbortController();
  const worker = provider.federation.startQueue(undefined, { signal: controller.signal });
  await new Promise((resolve) => setImmediate(resolve));
  await queue.enqueue({ type: "inbox", id: "admitted-activity", baseUrl: "https://worker.example/", identifier: "github-induction", attempt: 0, started: new Date().toISOString(), traceContext: {}, activity: { "@context": "https://www.w3.org/ns/activitystreams", id: "https://supplier.example/activities/admitted", type: "Create", actor: "https://supplier.example/actors/supplier", object: { type: "Note", content: "already Fedify-admitted work" } } });
  assert.equal(tasks.length, 1);
  const receipt = JSON.parse(Buffer.from(tasks[0].httpRequest.body, "base64url").toString("utf8"));
  assert.deepEqual(Object.keys(receipt).sort(), ["correlation", "custody", "v"], "Cloud Tasks sees only immutable custody/correlation identity");
  const workerRequest = () => new Request("https://worker.example/_private/github-induction-worker", { method: "POST", headers: { authorization: "Bearer verified" }, body: JSON.stringify(receipt) });
  assert.equal((await queue.consume(workerRequest())).status, 204);
  assert.equal(mutations, 1);
  assert.equal((await queue.consume(workerRequest())).status, 204, "authenticated retry is acknowledged");
  assert.equal(mutations, 1, "Fedify idempotency and saga custody prohibit another GitHub mutation");
  await assert.rejects(async () => { throw new Error("ActivityPub response delivery unavailable"); }, /unavailable/);
  const resumed = await executeInductionSaga(induction, { operationStore, induce: async () => ({ disposition: "bound", commit: `c${++mutations}` }) });
  assert.deepEqual(resumed, { disposition: "bound", commit: "c1", operation });
  assert.equal(mutations, 1, "bound result survives response-delivery failure");
  assert.equal((await markInductionResponseDelivered(operation, { operationStore })).state, "response-delivered");
  controller.abort(); await worker;
});
