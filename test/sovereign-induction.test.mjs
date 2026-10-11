import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { induceGithubSoftwareProposalLocally } from "@red-cup-engineering/github-services-section/software-induction";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

test("independently induces a multi-file proposal into a new sovereign repository", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "sovereign-induction-fixture-"));
  const source = join(fixture, "source");
  const archive = join(fixture, "source.tar.gz");
  mkdirSync(join(source, "seed"), { recursive: true });
  writeFileSync(join(source, "seed", "package.json"), "{}\n");
  execFileSync("tar", ["-czf", archive, "-C", source, "seed"]);

  const afterPackage = Buffer.from('{"name":"one-capability-cell","bin":{"serve":"./bin/serve.mjs"}}\n');
  const afterServer = Buffer.from('#!/usr/bin/env node\nprocess.stdout.write("ready\\n");\n');
  const changes = [
    { path: "package.json", beforeExisted: true, beforeDigest: digest(Buffer.from("{}\n")), afterDigest: digest(afterPackage), afterBytesBase64: afterPackage.toString("base64") },
    { path: "bin/serve.mjs", beforeExisted: false, beforeDigest: digest(Buffer.alloc(0)), afterDigest: digest(afterServer), afterBytesBase64: afterServer.toString("base64") },
  ];
  const calls = [];
  const api = {
    downloadRepositoryTarball: async (_repository, _commit, destination) => cpSync(archive, destination),
    getTreeEntries: async () => [{ path: "package.json", mode: "100644", sha: "old" }],
    getContentBytes: async (_repository, _commit, path) => path === "package.json" ? Buffer.from("{}\n") : null,
    createOrgRepository: async (owner, value) => calls.push(["createOrgRepository", owner, value.name]),
    createBlob: async (repository, bytes) => ({ sha: `${repository}:${digest(bytes)}` }),
    createTree: async (repository, value) => { calls.push(["createTree", repository, value]); return { sha: "tree" }; },
    createCommit: async (repository, value) => { calls.push(["createCommit", repository, value]); return { sha: "commit" }; },
    createRef: async (repository, ref, sha) => calls.push(["createRef", repository, ref, sha]),
  };
  const induce = (mission) => {
    mkdirSync(join(mission.territory, "bin"), { recursive: true });
    writeFileSync(join(mission.territory, "package.json"), afterPackage);
    writeFileSync(join(mission.territory, "bin/serve.mjs"), afterServer);
    return { appliedPaths: changes.map(({ path }) => path), verification: { passed: true }, acceptance: { passed: true } };
  };

  try {
    const receipt = await induceGithubSoftwareProposalLocally({
      source: { kind: "github-repository", repository: "harmonious-union/seed", commit: "a".repeat(40) },
      proposal: { type: "SoftwareMissionChangeProposal", proposalOnly: true, customerMutation: false, changes },
      writablePaths: ["package.json", "bin"],
      verifyCommand: "node --check bin/serve.mjs",
      target: { repository: "harmonious-union/one-capability-cell", ref: "heads/main", create: true },
    }, { api, induce });

    assert.equal(receipt.repository, "harmonious-union/one-capability-cell");
    assert.equal(receipt.priorCommit, null);
    assert.deepEqual(receipt.inducedPaths, ["package.json", "bin/serve.mjs"]);
    assert.deepEqual(calls.map(([operation]) => operation), ["createOrgRepository", "createTree", "createCommit", "createRef"]);
    assert.equal(calls[1][2].baseTree, undefined);
    assert.deepEqual(calls[2][2].parents, []);
    assert.deepEqual(calls[3].slice(1), ["harmonious-union/one-capability-cell", "refs/heads/main", "commit"]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("induces a verified gitlink transition as a commit tree entry", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "gitlink-induction-fixture-"));
  const source = join(fixture, "source"), child = join(fixture, "child");
  const sourceArchive = join(fixture, "source.tar.gz"), childArchive = join(fixture, "child.tar.gz");
  mkdirSync(join(source, "seed"), { recursive: true });
  mkdirSync(join(child, "successor"), { recursive: true });
  const gitmodules = '[submodule "cell"]\n\tpath = lib/cell\n\turl = https://github.com/harmonious-union/cell.git\n';
  writeFileSync(join(source, "seed", ".gitmodules"), gitmodules);
  writeFileSync(join(source, "seed", "verify.mjs"), 'import { readFileSync } from "node:fs"; if (readFileSync("lib/cell/report.txt", "utf8") !== "network successor\\n") process.exit(1);\n');
  writeFileSync(join(child, "successor", "report.txt"), "network successor\n");
  execFileSync("tar", ["-czf", sourceArchive, "-C", source, "seed"]);
  execFileSync("tar", ["-czf", childArchive, "-C", child, "successor"]);
  const beforeCommit = "b".repeat(40), afterCommit = "c".repeat(40), sourceCommit = "a".repeat(40);
  const calls = [];
  const api = {
    getRef: async () => sourceCommit,
    downloadRepositoryTarball: async (repository, _commit, destination) => cpSync(repository.endsWith("/cell") ? childArchive : sourceArchive, destination),
    getTreeEntries: async () => [{ path: "lib/cell", mode: "160000", type: "commit", sha: beforeCommit }],
    getContentBytes: async (_repository, _commit, path) => path === ".gitmodules" ? Buffer.from(gitmodules) : null,
    getCommit: async (repository, sha) => repository.endsWith("/cell") ? { sha } : { sha, tree: { sha: "parent-tree" } },
    createTree: async (_repository, value) => { calls.push(["createTree", value]); return { sha: "new-tree" }; },
    createCommit: async (_repository, value) => { calls.push(["createCommit", value]); return { sha: "new-commit" }; },
    updateRef: async (_repository, ref, sha) => calls.push(["updateRef", { ref, sha }]),
  };
  try {
    const receipt = await induceGithubSoftwareProposalLocally({
      source: { kind: "github-repository", repository: "harmonious-union/root", commit: sourceCommit },
      proposal: { type: "SoftwareMissionChangeProposal", proposalOnly: true, customerMutation: false, changes: [{
        kind: "gitlink", path: "lib/cell", repository: "harmonious-union/cell", beforeCommit, afterCommit,
      }] },
      writablePaths: ["lib/cell"], verifyCommand: "node verify.mjs",
      target: { repository: "harmonious-union/root", ref: "heads/main", create: false },
    }, { api });
    assert.equal(receipt.commit, "new-commit");
    assert.deepEqual(receipt.inducedPaths, ["lib/cell"]);
    assert.deepEqual(calls[0], ["createTree", { baseTree: "parent-tree", entries: [
      { path: "lib/cell", mode: "160000", type: "commit", sha: afterCommit },
    ] }]);
    assert.deepEqual(calls.at(-1), ["updateRef", { ref: "heads/main", sha: "new-commit" }]);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});

test("refuses target-ref drift immediately before publication", async () => {
  const fixture = mkdtempSync(join(tmpdir(), "ref-drift-induction-fixture-"));
  const source = join(fixture, "source"), archive = join(fixture, "source.tar.gz");
  mkdirSync(join(source, "seed"), { recursive: true });
  writeFileSync(join(source, "seed", "file.txt"), "before\n");
  execFileSync("tar", ["-czf", archive, "-C", source, "seed"]);
  const sourceCommit = "a".repeat(40), after = Buffer.from("after\n");
  let refReads = 0, updated = false;
  const api = {
    getRef: async () => ++refReads === 1 ? sourceCommit : "d".repeat(40),
    downloadRepositoryTarball: async (_repository, _commit, destination) => cpSync(archive, destination),
    getTreeEntries: async () => [{ path: "file.txt", mode: "100644", type: "blob", sha: "old-blob" }],
    getContentBytes: async () => Buffer.from("before\n"),
    createBlob: async () => ({ sha: "new-blob" }),
    getCommit: async () => ({ tree: { sha: "parent-tree" } }),
    createTree: async () => ({ sha: "new-tree" }),
    createCommit: async () => ({ sha: "new-commit" }),
    updateRef: async () => { updated = true; },
  };
  const proposal = { type: "SoftwareMissionChangeProposal", proposalOnly: true, customerMutation: false, changes: [{
    path: "file.txt", beforeExisted: true, beforeDigest: digest(Buffer.from("before\n")), afterDigest: digest(after), afterBytesBase64: after.toString("base64"),
  }] };
  try {
    await assert.rejects(induceGithubSoftwareProposalLocally({
      source: { kind: "github-repository", repository: "harmonious-union/root", commit: sourceCommit }, proposal,
      writablePaths: ["file.txt"], verifyCommand: "node --check file.txt",
      target: { repository: "harmonious-union/root", ref: "heads/main", create: false },
    }, { api, induce: () => ({ appliedPaths: ["file.txt"], verification: { passed: true }, acceptance: { passed: true } }) }), /target ref moved before compare-and-swap/);
    assert.equal(updated, false);
    assert.equal(refReads, 2);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
