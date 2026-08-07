import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const script = new URL("../ops/cloud-run/deploy.sh", import.meta.url);

test("release client builds committed context, stages a digest through the actuator, then cuts over that revision", async (t) => {
  let CLOUD_RUN_TAGGED_ROUTE_LIMITS;
  try { ({ CLOUD_RUN_TAGGED_ROUTE_LIMITS } = await import("../../../../../../../../../../../../web-services-section/services/web-platform-services-section/services/cloud-services-section/services/gcloud-services-section/services/gcloud-cloud-run-actuator-service/src/gcloud-cloud-run-actuator.mjs")); }
  catch (error) { if (error?.code === "ERR_MODULE_NOT_FOUND") return t.skip("actuator source is intentionally outside the runtime archive"); throw error; }
  const root = await mkdtemp(join(tmpdir(), "github-induction-release-"));
  const calls = join(root, "calls.jsonl"), gcloud = join(root, "gcloud"), actuator = join(root, "actuator"), prepare = join(root, "prepare-context"), preload = join(root, "acceptance-fetch.mjs");
  await writeFile(gcloud, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS"
if [[ "$1 $2" == "artifacts docker" ]]; then printf 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; fi
`, "utf8");
  await writeFile(actuator, `#!/usr/bin/env bash
set -euo pipefail
input=$(cat)
printf '%s\\n' "$input" >> "$CALLS"
  if [[ "$input" == *'"deploy-cloud-run-service"'* ]]; then printf '%s\\n' '{"receipt":{"object":{"content":{"revision":"github-software-induction-service-00042","tagUrl":"https://stage.example"}}}}'; else printf '%s\\n' '{"receipt":{"object":{"content":{}}}}'; fi
`, "utf8");
  await writeFile(prepare, `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "prepare-context $1" >> "$CALLS"
touch "$1/cloudbuild.yaml"
`, "utf8");
  await writeFile(preload, `import { appendFileSync } from "node:fs";
globalThis.fetch = async (input, init = {}) => {
  const url = String(input); appendFileSync(process.env.CALLS, \`FETCH \${init.method ?? "GET"} \${url}\\n\`);
  if (url.endsWith("/actors/github-software-induction-service")) return new Response(JSON.stringify({ type: "Service", id: "https://github-induction.example/actors/github-software-induction-service" }), { status: 200 });
  if (url.endsWith("/.well-known/agent-card.json")) return new Response(JSON.stringify({ signatures: [{ protected: "signed" }] }), { status: 200 });
  if (url.endsWith("/_private/github-induction-worker")) return new Response(null, { status: 401 });
  throw new Error(\`unexpected staged acceptance URL: \${url}\`);
};
`, "utf8");
  await Promise.all([chmod(gcloud, 0o755), chmod(actuator, 0o755), chmod(prepare, 0o755)]);
  await execute(script.pathname, [], { cwd: new URL("..", script).pathname, env: {
    ...process.env, PATH: `${root}:${process.env.PATH}`, CALLS: calls, ACTUATOR_CLI: actuator, PREPARE_CONTEXT_COMMAND: prepare,
    BUILD_TAG: "committed-source", NODE_OPTIONS: `--import=${preload}`,
    GOOGLE_CLOUD_PROJECT: "five-six-one-group-dev", ACTIVITYPUB_ORIGIN: "https://github-induction.example",
    CLOUDFLARE_R2_ACCOUNT_ID: "account", CLOUDFLARE_R2_BUCKET: "bucket", CLOUD_TASKS_LOCATION: "us-central1",
    CLOUD_TASKS_QUEUE: "github-induction", CLOUD_TASKS_SERVICE_ACCOUNT: "github-induction-worker@five-six-one-group-dev.iam.gserviceaccount.com",
    GCS_OPERATION_BUCKET: "github-induction-operations",
  } });
  const records = (await readFile(calls, "utf8")).trim().split("\n");
  assert.ok(records.some((record) => record.startsWith("builds submit ")));
  assert.ok(records.some((record) => record.startsWith("artifacts docker images describe ")));
  assert.equal(records.some((record) => /\brun (?:deploy|services update-traffic)\b/u.test(record)), false);
  const requests = records.filter((record) => record.startsWith("{")).map(JSON.parse);
  const staged = requests.find((request) => request.operation === "deploy-cloud-run-service");
  const cutover = requests.find((request) => request.operation === "cutover-cloud-run-service");
  assert.match(staged.image, /@sha256:a{64}$/u);
  assert.equal(staged.image.includes(":" + "latest"), false);
  assert.equal(staged.environment.BASE_URL, "https://github-induction.example");
  assert.equal(staged.environment.ACTIVITYPUB_ORIGIN, "https://github-induction.example");
  assert.equal(staged.environment.CLOUD_TASKS_QUEUE, "github-induction");
  assert.equal(staged.environment.GCS_OPERATION_BUCKET, "github-induction-operations");
  assert.equal(staged.environment.GCS_OPERATION_PREFIX, "operations/github-induction/v1/");
  assert.match(staged.revisionTag, /^s-[a-f0-9]{6}$/u);
  assert.ok("github-software-induction-service".length + staged.revisionTag.length <= CLOUD_RUN_TAGGED_ROUTE_LIMITS.maxServiceAndTagCharacters);
  assert.equal(staged.secretBindings.GITHUB_SERVICES_TOKEN, "github-software-induction-token:latest");
  assert.equal(staged.secretBindings["/secrets/activitypub/keys.json"], "github-software-induction-activitypub-keys:latest");
  assert.equal(cutover.revision, "github-software-induction-service-00042");
  assert.equal(cutover.canonicalOrigin, staged.environment.ACTIVITYPUB_ORIGIN);
  assert.deepEqual(records.filter((record) => record.startsWith("FETCH ")), [
    "FETCH GET https://stage.example/actors/github-software-induction-service",
    "FETCH GET https://stage.example/.well-known/agent-card.json",
    "FETCH POST https://stage.example/_private/github-induction-worker",
  ]);
  assert.ok(records.indexOf(JSON.stringify(cutover)) > records.findIndex((record) => record.startsWith("FETCH POST ")), "cutover follows staged acceptance");
});

test("release client refuses an unstable placeholder origin before it builds", async () => {
  const root = await mkdtemp(join(tmpdir(), "github-induction-refusal-"));
  const actuator = join(root, "actuator"), prepare = join(root, "prepare-context"), gcloud = join(root, "gcloud");
  await Promise.all([
    writeFile(actuator, "#!/usr/bin/env bash\nexit 99\n", { mode: 0o755 }),
    writeFile(prepare, "#!/usr/bin/env bash\nexit 99\n", { mode: 0o755 }),
    writeFile(gcloud, "#!/usr/bin/env bash\nexit 99\n", { mode: 0o755 }),
  ]);
  await assert.rejects(() => execute(script.pathname, [], { cwd: new URL("..", script).pathname, env: {
    ...process.env, PATH: `${root}:${process.env.PATH}`, ACTUATOR_CLI: actuator, PREPARE_CONTEXT_COMMAND: prepare, BUILD_TAG: "committed-source",
    GOOGLE_CLOUD_PROJECT: "five-six-one-group-dev", ACTIVITYPUB_ORIGIN: "https://github-software-induction-service.invalid",
    CLOUDFLARE_R2_ACCOUNT_ID: "account", CLOUDFLARE_R2_BUCKET: "bucket", CLOUD_TASKS_LOCATION: "us-central1", CLOUD_TASKS_QUEUE: "queue",
    CLOUD_TASKS_SERVICE_ACCOUNT: "worker@five-six-one-group-dev.iam.gserviceaccount.com", GCS_OPERATION_BUCKET: "operations",
  } }), /stable canonical HTTPS origin/u);
});
