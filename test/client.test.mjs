import assert from "node:assert/strict";
import test from "node:test";
import { extractRmnActivity } from "@red-cup-engineering/activitypub-services-section/rmn-activity";
import { induceGithubSoftwareProposal } from "../src/client.mjs";
import { operationFromBytes } from "../src/a2a-executor.mjs";

test("client carries one exact induction request through ActivityPub CloudEvents", async () => {
  let sent;
  const input = { source: { kind: "github-repository", repository: "union/root", commit: "a".repeat(40) } };
  const receipt = await induceGithubSoftwareProposal(input, {
    origin: "https://customer.example", identifier: "customer", keyPath: "/secret/keys.json",
    agentCard: "https://customer.example/.well-known/agent-card.json",
    recipient: "https://provider.example/actors/github", inbox: "https://provider.example/actors/github/inbox",
    eventTime: "2026-07-30T01:00:00.000Z",
    deliver: async (activity, options) => { sent = { activity, options }; return { delivered: true }; },
  });
  assert.equal(receipt.disposition, "submitted");
  const projected = extractRmnActivity(sent.activity, {
    expectedActor: "https://customer.example/actors/customer",
    expectedRecipient: "https://provider.example/actors/github",
  });
  const request = operationFromBytes(projected.objectBytes);
  assert.equal(request.id, receipt.request);
  assert.deepEqual(request.input, input);
  assert.equal(sent.options.inbox, "https://provider.example/actors/github/inbox");
});
