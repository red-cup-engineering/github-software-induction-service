import assert from "node:assert/strict";
import test from "node:test";
import { createGithubInductionProductionRuntime } from "../src/github-induction-production-runtime.mjs";

const environment = Object.freeze({
  ACTIVITYPUB_ORIGIN: "https://github-induction.example",
  GOOGLE_CLOUD_PROJECT: "five-six-one-group-dev",
  CLOUD_TASKS_LOCATION: "us-central1",
  CLOUD_TASKS_QUEUE: "github-induction",
  CLOUD_TASKS_SERVICE_ACCOUNT: "github-induction-worker@five-six-one-group-dev.iam.gserviceaccount.com",
  GCS_OPERATION_BUCKET: "five-six-one-github-induction-operations",
  GCS_OPERATION_PREFIX: "operations/github-induction/v1/",
});

test("production runtime refuses incomplete or noncanonical cloud environment", () => {
  const factories = { createGoogleApiRequest: () => {}, createImmutableContentCustody: () => ({ put() {}, get() {} }), createGoogleOidcVerifier: () => () => true, createCloudTasksMessageQueue: () => ({}), createGcsTransactionalOperationStore: () => ({}) };
  const incomplete = { ...environment }; delete incomplete.CLOUD_TASKS_QUEUE;
  assert.throws(() => createGithubInductionProductionRuntime({ environment: incomplete, ...factories }), /CLOUD_TASKS_QUEUE/);
  assert.throws(() => createGithubInductionProductionRuntime({ environment: { ...environment, ACTIVITYPUB_ORIGIN: "https://github-induction.example/has-a-path" }, ...factories }), /canonical HTTPS origin/);
});

test("production runtime binds Cloud Tasks to the canonical private worker and GCS CAS", async () => {
  const calls = {};
  const immutable = {
    put: async (input) => { calls.put = input; },
    get: async (ni) => { calls.get = ni; return ni === "ni:///sha-256;AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" ? { bytes: Buffer.from("message") } : null; },
  };
  const runtime = createGithubInductionProductionRuntime({
    environment,
    createGoogleApiRequest: () => { const request = async () => new Response(); calls.request = request; return request; },
    createImmutableContentCustody: () => immutable,
    createGoogleOidcVerifier: (input) => { calls.verifier = input; return async () => true; },
    createCloudTasksMessageQueue: (input) => { calls.queue = input; return { consume: async () => new Response(null, { status: 204 }) }; },
    createGcsTransactionalOperationStore: (input) => { calls.store = input; return { get: async () => undefined, compareAndSet: async () => ({ version: "1" }) }; },
  });
  assert.equal(runtime.origin, environment.ACTIVITYPUB_ORIGIN);
  assert.equal(runtime.targetUrl, "https://github-induction.example/_private/github-induction-worker");
  assert.equal(calls.queue.targetUrl, runtime.targetUrl);
  assert.equal(calls.queue.audience, runtime.targetUrl);
  assert.equal(calls.queue.request, calls.request);
  assert.equal(calls.store.request, calls.request);
  assert.deepEqual(calls.verifier, { audience: runtime.targetUrl, serviceAccountEmail: environment.CLOUD_TASKS_SERVICE_ACCOUNT });
  await calls.queue.custody.retain({ identity: "ni:///sha-256;AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", mediaType: "application/test", bytes: Buffer.from("message") });
  assert.equal(calls.put.ni, "ni:///sha-256;AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
  assert.deepEqual(await calls.queue.custody.retrieve("ni:///sha-256;AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"), Buffer.from("message"));
  assert.equal(await calls.queue.custody.retrieve("ni:///sha-256;BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"), undefined);
});
