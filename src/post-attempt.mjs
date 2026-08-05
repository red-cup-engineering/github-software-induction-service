// Publication effect. Publishes an authorized attempt package through the hired GitHub provider:
// comments `/attempt`, forks the bounty repo, pushes the fix to a branch on the fork, and
// opens a PR upstream whose body carries `/claim`. This is the ONLY code in the system that
// writes to the outside world, so it is TRIPLE-GATED and refuses unless all three are set:
//   - opts.enabled === true      (explicit call-site intent)
//   - opts.confirm === true       (explicit second confirmation)
//   - process.env.POSTING_ENABLED === "1"   (environment kill-switch, default off)
// Note: Algora ignores bot-authored events, so the token MUST belong to a human-type account.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { githubApi } from "@red-cup-engineering/github-services-section";
import { runTestsCommand } from "@red-cup-engineering/sandbox-command-execution-service";

const digest = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

function assertProposal(proposal) {
  if (proposal?.type !== "SoftwareMissionChangeProposal" || proposal.proposalOnly !== true
      || proposal.customerMutation !== false || !Array.isArray(proposal.changes)
      || proposal.changes.length === 0) {
    throw new Error("customer induction requires one proposal-only software change set");
  }
}

function inside(root, requested) {
  const path = resolve(root, requested);
  if (path !== resolve(root) && !path.startsWith(`${resolve(root)}${sep}`)) {
    throw new Error(`customer induction path escapes the admitted territory: ${requested}`);
  }
  return path;
}

function assertAdmittedPath(root, requested, writablePaths, seen) {
  const path = relative(root, inside(root, requested));
  if (!path || seen.has(path)) throw new Error(`customer induction proposal path is invalid or repeated: ${requested}`);
  seen.add(path);
  if (!writablePaths.some((lane) => path === lane || path.startsWith(`${lane}${sep}`))) {
    throw new Error(`customer induction path is outside the declared writable lane: ${path}`);
  }
  return path;
}

function repositoryFromGitmodules(bytes, submodulePath, sourceRepository) {
  const text = bytes.toString("utf8");
  for (const section of text.split(/^\s*\[submodule\s+"[^"]+"\]\s*$/mu).slice(1)) {
    const path = /^\s*path\s*=\s*(.+?)\s*$/mu.exec(section)?.[1];
    if (path !== submodulePath) continue;
    const url = /^\s*url\s*=\s*(.+?)\s*$/mu.exec(section)?.[1];
    if (!url) break;
    const absolute = /^(?:https:\/\/github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(url)?.[1];
    if (absolute) return absolute;
    const relativeRepository = /^\.\.\/([A-Za-z0-9_.-]+?)(?:\.git)?$/u.exec(url)?.[1];
    if (relativeRepository) return `${sourceRepository.split("/")[0]}/${relativeRepository}`;
    break;
  }
  throw new Error(`gitlink ${submodulePath} is not bound to an admitted GitHub repository in .gitmodules`);
}

async function admitProposalAtJsMark({ territory, source, proposal, writablePaths, verifyCommand, acceptanceCommand, existing, api }) {
  if (!Array.isArray(writablePaths) || writablePaths.length === 0) throw new Error("customer induction requires an explicit writable lane");
  const lanes = writablePaths.map((path) => relative(territory, inside(territory, path)));
  const seen = new Set(), appliedPaths = [];
  const gitmodules = proposal.changes.some((change) => change.kind === "gitlink")
    ? await api.getContentBytes(source.repository, source.commit, ".gitmodules")
    : null;
  for (const change of proposal.changes) {
    const path = assertAdmittedPath(territory, change?.path, lanes, seen);
    const current = existing.get(path);
    if (change.kind === "gitlink") {
      if (!/^[0-9a-f]{40}$/u.test(change.beforeCommit ?? "") || !/^[0-9a-f]{40}$/u.test(change.afterCommit ?? "")) {
        throw new Error(`gitlink transition lacks immutable commit identities: ${path}`);
      }
      if (current?.type !== "commit" || current.mode !== "160000" || current.sha !== change.beforeCommit) {
        throw new Error(`customer induction gitlink before-state drift: ${path}`);
      }
      const repository = repositoryFromGitmodules(gitmodules ?? Buffer.alloc(0), path, source.repository);
      if (change.repository !== undefined && change.repository !== repository) {
        throw new Error(`gitlink repository conflicts with .gitmodules: ${path}`);
      }
      const commit = await api.getCommit(repository, change.afterCommit);
      if (commit?.sha !== undefined && commit.sha !== change.afterCommit) throw new Error(`gitlink target commit identity drift: ${path}`);
      const target = inside(territory, path), archive = join(dirname(target), `.gitlink-${createHash("sha256").update(path).digest("hex")}.tar.gz`);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(target, { recursive: true });
      await api.downloadRepositoryTarball(repository, change.afterCommit, archive);
      try {
        execFileSync("tar", ["-xzf", archive, "-C", target, "--strip-components=1"], { stdio: "pipe" });
      } finally {
        rmSync(archive, { force: true });
      }
      appliedPaths.push(path);
      continue;
    }
    if (current && current.type !== "blob") throw new Error(`ordinary file transition targets a non-blob Git object: ${path}`);
    const before = await api.getContentBytes(source.repository, source.commit, path);
    const observedBefore = before ?? Buffer.alloc(0);
    if ((before !== null) !== change.beforeExisted || digest(observedBefore) !== change.beforeDigest) {
      throw new Error(`customer induction before-state drift: ${path}`);
    }
    const after = Buffer.from(change.afterBytesBase64 ?? "", "base64");
    if (digest(after) !== change.afterDigest) throw new Error(`customer induction after-state drift: ${path}`);
    const target = inside(territory, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, after);
    appliedPaths.push(path);
  }
  const verification = runTestsCommand(territory, verifyCommand);
  const acceptance = acceptanceCommand === verifyCommand ? verification : runTestsCommand(territory, acceptanceCommand);
  if (!verification.passed || !acceptance.passed) {
    throw new Error(`customer induction checks failed: ${verification.output || acceptance.output}`);
  }
  return Object.freeze({ appliedPaths, verification: { passed: true }, acceptance: { passed: true } });
}

/** Independently materialize and verify a supplier proposal, then publish all
 * admitted paths as one Git tree/commit/ref compare-and-swap. */
export async function induceGithubSoftwareProposalLocally({
  source,
  proposal,
  writablePaths,
  verifyCommand,
  acceptanceCommand = verifyCommand,
  target = { repository: source?.repository, ref: "heads/main", create: false },
  commitMessage = "Induce verified software proposal",
  chain,
}, { api = githubApi(), induce, operationKey, onState = () => {} } = {}) {
  assertProposal(proposal);
  if (source?.kind !== "github-repository" || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(source.repository ?? "")
      || !/^[0-9a-f]{40}$/u.test(source.commit ?? "")) {
    throw new Error("customer induction source must bind one immutable GitHub commit");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(target?.repository ?? "")
      || typeof target.ref !== "string" || !/^heads\/[A-Za-z0-9._/-]+$/u.test(target.ref)
      || (target.repository !== source.repository && target.create !== true)) {
    throw new Error("customer induction target must be the source repository or a declared new sovereign repository");
  }
  const creatingRepository = target.repository !== source.repository && target.create === true;
  if (!creatingRepository) {
    const observedHead = await api.getRef(target.repository, target.ref.slice("heads/".length));
    if (observedHead !== source.commit) throw new Error("customer induction target ref moved from the admitted source commit");
  }

  const parent = mkdtempSync(join(tmpdir(), "github-software-induction-"));
  const territory = join(parent, "territory"), archive = join(parent, "source.tar.gz");
  mkdirSync(territory);
  try {
    await api.downloadRepositoryTarball(source.repository, source.commit, archive);
    execFileSync("tar", ["-xzf", archive, "-C", territory, "--strip-components=1"], { stdio: "pipe" });
    await onState("materialized");
    const existing = new Map((await api.getTreeEntries(source.repository, source.commit))
      .map((entry) => [entry.path, entry]));
    const receipt = induce ? await induce({ territory, writablePaths, verifyCommand, acceptanceCommand }, {
      semanticId: proposal.id ?? null, outcome: { candidateVerified: true, proposal },
    }) : await admitProposalAtJsMark({ territory, source, proposal, writablePaths, verifyCommand, acceptanceCommand, existing, api });
    if (!receipt?.verification?.passed || !receipt?.acceptance?.passed) {
      throw new Error("customer induction did not independently verify and accept the proposal");
    }
    await onState("verified");
    const readJson = (relativePath) => {
      const path = join(territory, relativePath);
      return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : null;
    };
    const projections = {
      packageManifest: readJson("package.json"),
      cellManifest: readJson("content/capcell/manifest.json"),
      cellIdentity: readJson("content/capcell/identity.json"),
      customerInvocation: readJson("content/capcell/customer-invocation.json"),
      accountBinding: /^eip155:[1-9][0-9]*$/u.test(chain?.caip2 ?? "")
        ? readJson(`content/evm/accounts/eip155-${chain.caip2.split(":")[1]}.json`)
        : null,
    };
    const entrypoints = projections.packageManifest ? [
      ...Object.values(projections.packageManifest.bin ?? {}),
      ...(typeof projections.packageManifest.exports === "string"
        ? [projections.packageManifest.exports]
        : Object.values(projections.packageManifest.exports ?? {}).filter((value) => typeof value === "string")),
    ] : [];
    projections.runnableEntrypoints = entrypoints.filter((path) => existsSync(join(territory, path)));

    if (creatingRepository) {
      const [owner, name] = target.repository.split("/");
      await api.createOrgRepository(owner, {
        name,
        description: target.description ?? `Sovereign capability cell fabricated from ${source.repository}@${source.commit}`,
        visibility: target.visibility ?? "public",
      });
    }
    const entries = [];
    for (const change of proposal.changes) {
      if (change.kind === "gitlink") {
        entries.push({ path: change.path, mode: "160000", type: "commit", sha: change.afterCommit });
        continue;
      }
      const before = await api.getContentBytes(source.repository, source.commit, change.path);
      const observedBefore = before ?? Buffer.alloc(0);
      if ((before !== null) !== change.beforeExisted || digest(observedBefore) !== change.beforeDigest) {
        throw new Error(`customer induction before-state drift: ${change.path}`);
      }
      const after = Buffer.from(change.afterBytesBase64, "base64");
      if (digest(after) !== change.afterDigest) throw new Error(`customer induction after-state drift: ${change.path}`);
      const blob = await api.createBlob(target.repository, after);
      entries.push({ path: change.path, mode: existing.get(change.path)?.mode ?? "100644", type: "blob", sha: blob.sha });
    }
    const parentCommit = creatingRepository ? null : await api.getCommit(source.repository, source.commit);
    const tree = await api.createTree(target.repository, { baseTree: parentCommit?.tree.sha, entries });
    await onState("publication-attempted");
    const commit = await api.createCommit(target.repository, {
      message: operationKey ? `${commitMessage}\n\nRMN-Request: ${operationKey}` : commitMessage,
      tree: tree.sha,
      parents: creatingRepository ? [] : [source.commit],
    });
    if (creatingRepository) await api.createRef(target.repository, `refs/${target.ref}`, commit.sha);
    else {
      const observedHead = await api.getRef(target.repository, target.ref.slice("heads/".length));
      if (observedHead !== source.commit) throw new Error("customer induction target ref moved before compare-and-swap");
      await api.updateRef(target.repository, target.ref, commit.sha);
    }
    return Object.freeze({
      disposition: "bound",
      provider: "urn:ame:github-software-induction-service",
      repository: target.repository,
      ref: target.ref,
      priorCommit: creatingRepository ? null : source.commit,
      commit: commit.sha,
      inducedPaths: receipt.appliedPaths,
      verification: receipt.verification,
      acceptance: receipt.acceptance,
      operation: operationKey ?? null,
      projections,
    });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
}

export function postingAllowed(opts = {}) {
  return opts.enabled === true && opts.confirm === true && process.env.POSTING_ENABLED === "1";
}

export async function postAttempt(pkg, opts = {}) {
  if (!postingAllowed(opts)) {
    return { posted: false, reason: "posting disabled — needs enabled:true + confirm:true + POSTING_ENABLED=1" };
  }
  const gh = opts.api || githubApi();
  const { repo, issueNumber, file, attemptComment, claimPrBody } = pkg;
  const after = pkg.change?.after;
  if (!after) return { posted: false, reason: "package has no fixed file content" };

  // 1. Declare the attempt on the issue.
  await gh.createIssueComment(repo, issueNumber, attemptComment);
  // 2. Fork the bounty repo (we can't push to it directly).
  const fork = await gh.forkRepo(repo);
  // 3. Branch the fork off its default branch.
  const base = fork.default_branch;
  const baseSha = await gh.getRef(fork.full_name, base);
  const branch = opts.branch || `algora-fix-${issueNumber}`;
  await gh.createRef(fork.full_name, `refs/heads/${branch}`, baseSha);
  // 4. Commit the fix onto that branch.
  const sha = await gh.getFileSha(fork.full_name, file, branch);
  await gh.putFile(fork.full_name, file, {
    message: `Fix #${issueNumber}`,
    content: Buffer.from(after, "utf8").toString("base64"),
    branch,
    sha,
  });
  // 5. Open the PR upstream with the /claim body.
  const pr = await gh.createPullRequest(repo, {
    title: `Fix #${issueNumber}`,
    head: `${fork.owner}:${branch}`,
    base,
    body: claimPrBody,
  });
  return { posted: true, commentedOn: `${repo}#${issueNumber}`, prUrl: pr.html_url ?? pr.url ?? null };
}
