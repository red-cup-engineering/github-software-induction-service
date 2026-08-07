import { test } from "node:test";
import assert from "node:assert/strict";
import { postAttempt, postingAllowed } from "../src/post-attempt.mjs";

const pkg = {
  repo: "acme/widgets", issueNumber: 42, file: "src/a.js",
  attemptComment: "/attempt #42", claimPrBody: "Fixes #42\n\n/claim #42",
  change: { after: "fixed code" },
};

function fakeApi() {
  const calls = [];
  const rec = (name) => async (...a) => { calls.push(name); return name === "createPullRequest" ? { html_url: "https://github.com/acme/widgets/pull/1" } : name === "forkRepo" ? { full_name: "me/widgets", owner: "me", default_branch: "main" } : name === "getRef" ? "basesha" : {}; };
  return { calls, createIssueComment: rec("createIssueComment"), forkRepo: rec("forkRepo"), getRef: rec("getRef"), createRef: rec("createRef"), getFileSha: rec("getFileSha"), putFile: rec("putFile"), createPullRequest: rec("createPullRequest") };
}

test("refuses by default (no gates set)", async () => {
  delete process.env.POSTING_ENABLED;
  const r = await postAttempt(pkg, { api: fakeApi() });
  assert.equal(r.posted, false);
  assert.match(r.reason, /disabled/);
});

test("refuses even with enabled+confirm if the env kill-switch is off", async () => {
  delete process.env.POSTING_ENABLED;
  assert.equal(postingAllowed({ enabled: true, confirm: true }), false);
  const r = await postAttempt(pkg, { enabled: true, confirm: true, api: fakeApi() });
  assert.equal(r.posted, false);
});

test("with all three gates, runs the full comment->fork->branch->commit->PR sequence", async () => {
  process.env.POSTING_ENABLED = "1";
  const api = fakeApi();
  const r = await postAttempt(pkg, { enabled: true, confirm: true, api });
  delete process.env.POSTING_ENABLED;
  assert.equal(r.posted, true);
  assert.equal(r.prUrl, "https://github.com/acme/widgets/pull/1");
  assert.deepEqual(api.calls, ["createIssueComment", "forkRepo", "getRef", "createRef", "getFileSha", "putFile", "createPullRequest"]);
});
