import assert from "node:assert/strict";
import test from "node:test";
import { executeInductionSaga, markInductionResponseDelivered } from "../src/induction-saga.mjs";

const request = (id = "rmn:request:one") => ({ id, input: { source: { commit: "a".repeat(40), repository: "union/root" }, target: { repository: "union/root", ref: "heads/main" } } });
function memoryStore() {
  const records = new Map();
  return {
    async get(key) { return records.get(key) ?? null; },
    async compareAndSet(key, version, record) {
      const current = records.get(key) ?? null;
      if ((current?.version ?? null) !== version) throw new Error("stale operation-store version");
      const stored = Object.freeze({ ...record, version: (current?.version ?? 0) + 1 }); records.set(key, stored); return stored;
    },
  };
}

test("duplicate delivery resumes one exact RMN operation without another mutation", async () => {
  const operationStore = memoryStore(); let mutations = 0;
  const induce = async () => ({ disposition: "bound", commit: `c${++mutations}` });
  const first = await executeInductionSaga(request(), { induce, operationStore });
  const second = await executeInductionSaga(request(), { induce, operationStore });
  assert.equal(mutations, 1); assert.equal(first.operation, request().id); assert.deepEqual(second, first);
});

test("reconciles GitHub commit identity after a crash following publication", async () => {
  const operationStore = memoryStore(), key = request().id; let mutations = 0;
  const crash = async (_input, { onState }) => { await onState("publication-attempted"); mutations += 1; throw new Error("process died after Git commit"); };
  const api = { getRef: async () => "c".repeat(40), getCommit: async () => ({ message: `Induce\n\nRMN-Request: ${key}`, parents: [{ sha: "a".repeat(40) }] }) };
  await assert.rejects(executeInductionSaga(request(), { induce: crash, operationStore, provider: { api } }), /process died/);
  const recovered = await executeInductionSaga(request(), { induce: async () => { mutations += 1; }, operationStore, provider: { api } });
  assert.equal(recovered.recovered, true); assert.equal(recovered.commit, "c".repeat(40)); assert.equal(mutations, 1);
});

test("a post-attempt ref identity mismatch is publication-uncertain and never reruns", async () => {
  const operationStore = memoryStore(); let mutations = 0;
  await assert.rejects(executeInductionSaga(request(), { operationStore, induce: async (_input, { onState }) => { await onState("publication-attempted"); mutations += 1; throw new Error("lost response"); } }), /lost response/);
  await assert.rejects(executeInductionSaga(request(), { operationStore, induce: async () => { mutations += 1; }, provider: { api: { getRef: async () => "d".repeat(40), getCommit: async () => ({ message: "unrelated", parents: [] }) } } }), /uncertain/);
  assert.equal(mutations, 1);
});

test("response delivery failure does not rerun a bound mutation", async () => {
  const operationStore = memoryStore(); let mutations = 0;
  await executeInductionSaga(request(), { operationStore, induce: async () => ({ disposition: "bound", commit: `c${++mutations}` }) });
  await assert.rejects(async () => { throw new Error("ActivityPub response unavailable"); }, /unavailable/);
  const retried = await executeInductionSaga(request(), { operationStore, induce: async () => ({ commit: `c${++mutations}` }) });
  assert.equal(retried.commit, "c1"); assert.equal(mutations, 1);
  assert.equal((await markInductionResponseDelivered(request().id, { operationStore })).state, "response-delivered");
});

test("compare-and-set grants one concurrent duplicate delivery the admission ownership", async () => {
  const operationStore = memoryStore(); let mutations = 0;
  const induce = async () => { mutations += 1; await new Promise((resolve) => setImmediate(resolve)); return { disposition: "bound", commit: "c" }; };
  const outcomes = await Promise.allSettled([executeInductionSaga(request("rmn:request:race"), { induce, operationStore }), executeInductionSaga(request("rmn:request:race"), { induce, operationStore })]);
  assert.equal(mutations, 1); assert.equal(outcomes.filter((outcome) => outcome.status === "fulfilled").length, 1);
  assert.match(outcomes.find((outcome) => outcome.status === "rejected").reason.message, /already admitted/);
});

test("fails closed when no durable cloud operation store is injected", async () => {
  await assert.rejects(executeInductionSaga(request(), { induce: async () => ({}) }), /durable operation store/);
});
