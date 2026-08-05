import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const packagePath = "services/web-platform-services-section/services/web2-platform-services-section/services/web2-software-platform-services-section/services/github-services-section/services/github-software-induction-service";
const archiveRoot = "lib/emsenn/services/561-group/services/engineering-services-section/services/computer-services-section/services/web-services-section";

async function write(root, relative, body) {
  const path = join(root, relative);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, body, "utf8");
}

test("Git-object build context excludes dirty source and contains recursive file dependencies", async () => {
  const root = await mkdtemp(join(tmpdir(), "git-object-context-"));
  const context = await mkdtemp(join(tmpdir(), "git-object-output-"));
  const linked = await mkdtemp(join(tmpdir(), "git-object-linked-"));
  const script = join(root, packagePath, "ops/cloud-run/prepare-context.sh");
  const localPath = "services/local";
  const linkedPath = "services/linked";
  await write(root, `${packagePath}/package.json`, JSON.stringify({ dependencies: {
    "@union/local": `file:${relative(packagePath, localPath)}`,
    "@union/linked": `file:${relative(packagePath, linkedPath)}`,
  } }));
  await write(root, `${packagePath}/package-lock.json`, "{\"lockfileVersion\":3,\"packages\":{}}\n");
  await write(root, `${packagePath}/src/entry.mjs`, "export const source = 'committed';\n");
  await write(root, `${packagePath}/ops/cloud-run/Dockerfile`, "FROM scratch\n");
  await write(root, `${packagePath}/ops/cloud-run/cloudbuild.yaml`, "steps: []\n");
  await write(root, `${localPath}/package.json`, "{}\n");
  await write(root, `${localPath}/src/value.mjs`, "export const local = true;\n");
  await write(linked, "package.json", "{\"name\":\"@union/linked\",\"version\":\"1.0.0\"}\n");
  await write(linked, "src/value.mjs", "export const linked = 'committed';\n");
  await execute("git", ["init", "-q"], { cwd: linked });
  await execute("git", ["config", "user.email", "test@example.invalid"], { cwd: linked });
  await execute("git", ["config", "user.name", "Test"], { cwd: linked });
  await execute("git", ["add", "."], { cwd: linked });
  await execute("git", ["commit", "-qm", "linked closure"], { cwd: linked });
  const linkedCommit = (await execute("git", ["rev-parse", "HEAD"], { cwd: linked })).stdout.trim();
  const source = await readFile(new URL("../ops/cloud-run/prepare-context.sh", import.meta.url), "utf8");
  await write(root, `${packagePath}/ops/cloud-run/prepare-context.sh`, source);
  await chmod(script, 0o755);
  await execute("git", ["init", "-q"], { cwd: root });
  await execute("git", ["config", "user.email", "test@example.invalid"], { cwd: root });
  await execute("git", ["config", "user.name", "Test"], { cwd: root });
  await execute("git", ["-c", "protocol.file.allow=always", "submodule", "add", "-q", linked, linkedPath], { cwd: root });
  await execute("git", ["add", "."], { cwd: root });
  await execute("git", ["commit", "-qm", "closure"], { cwd: root });
  await write(root, `${packagePath}/src/entry.mjs`, "export const source = 'dirty';\n");
  await write(root, `${linkedPath}/src/value.mjs`, "export const linked = 'dirty';\n");
  await execute(script, [context], { cwd: root });
  const archived = join(context, archiveRoot);
  assert.match(await readFile(join(archived, packagePath, "src/entry.mjs"), "utf8"), /committed/);
  await readFile(join(archived, localPath, "src/value.mjs"), "utf8");
  assert.match(await readFile(join(archived, linkedPath, "src/value.mjs"), "utf8"), /committed/);
  assert.doesNotMatch(await readFile(join(archived, linkedPath, "src/value.mjs"), "utf8"), /dirty/);
  assert.match(await readFile(join(context, "git-object-closure.jsonl"), "utf8"), new RegExp(linkedCommit));
  assert.equal((await readFile(join(context, "Dockerfile"), "utf8")).trim(), "FROM scratch");
});

test("production Docker closure preserves its committed lock and uses npm ci", async () => {
  const dockerfile = await readFile(new URL("../ops/cloud-run/Dockerfile", import.meta.url), "utf8");
  assert.match(dockerfile, /test -f package-lock\.json/);
  assert.match(dockerfile, /npm ci --install-links --omit=dev --no-audit --no-fund/);
  assert.doesNotMatch(dockerfile, /rm -f package-lock\.json|npm install --omit=dev/);
});

test("ordinary pre-publication assay imports the committed archive without .git or command-path fallbacks", async () => {
  const context = await mkdtemp(join(tmpdir(), "github-induction-archive-assay-"));
  const service = new URL("..", import.meta.url).pathname;
  const prepare = join(service, "ops/cloud-run/prepare-context.sh");
  try {
    let archived = service;
    try {
      const repository = (await execute("git", ["rev-parse", "--show-toplevel"], { cwd: service })).stdout.trim();
      await execute(prepare, [context], { cwd: repository });
      await assert.rejects(access(join(context, ".git")), /ENOENT/u);
      archived = join(context, archiveRoot, packagePath);
      await execute("npm", ["ci", "--install-links", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: archived });
    } catch (error) {
      if (!/not a git repository/u.test(String(error))) throw error;
      await assert.rejects(access(join(service, ".git")), /ENOENT/u);
    }
    const custody = await readFile(join(archived, "node_modules/@red-cup-engineering/immutable-content-custody-service/src/immutable-content-custody.mjs"), "utf8");
    assert.match(custody, /from "\.\/r2-sigv4\.mjs"/u, "immutable custody remains the sole direct SigV4 owner");
    const runtime = await readFile(join(archived, "src/github-induction-production-runtime.mjs"), "utf8");
    assert.match(runtime, /from "@red-cup-engineering\/immutable-content-custody-service"/u);
    assert.doesNotMatch(runtime, /r2-sigv4|createR2SigV4Client|child_process/u, "runtime uses custody and managed-runtime authorities rather than command fallbacks");
    await execute(process.execPath, ["--input-type=module", "--eval", "await import('./src/github-induction-production-runtime.mjs')"], {
      cwd: archived,
      env: { ...process.env, PATH: join(context, "no-external-commands") },
    });
  } finally {
    await rm(context, { recursive: true, force: true });
  }
});
