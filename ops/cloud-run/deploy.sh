#!/usr/bin/env bash
set -euo pipefail

: "${GOOGLE_CLOUD_PROJECT:?set GOOGLE_CLOUD_PROJECT}"
: "${CLOUDFLARE_R2_ACCOUNT_ID:?set CLOUDFLARE_R2_ACCOUNT_ID}"
: "${CLOUDFLARE_R2_BUCKET:?set CLOUDFLARE_R2_BUCKET}"
: "${ACTIVITYPUB_ORIGIN:?set ACTIVITYPUB_ORIGIN to the final canonical HTTPS origin}"
: "${CLOUD_TASKS_LOCATION:?set CLOUD_TASKS_LOCATION}"
: "${CLOUD_TASKS_QUEUE:?set CLOUD_TASKS_QUEUE}"
: "${CLOUD_TASKS_SERVICE_ACCOUNT:?set CLOUD_TASKS_SERVICE_ACCOUNT}"
: "${GCS_OPERATION_BUCKET:?set GCS_OPERATION_BUCKET}"
export GCS_OPERATION_PREFIX=${GCS_OPERATION_PREFIX:-operations/github-induction/v1/}
[[ "$GCS_OPERATION_PREFIX" =~ ^[a-z0-9][a-z0-9._/-]*/$ && "$GCS_OPERATION_PREFIX" != *"//"* && "$GCS_OPERATION_PREFIX" != /* ]] || { echo "GCS_OPERATION_PREFIX must be one relative object prefix ending in /" >&2; exit 64; }
script_dir=$(CDPATH= cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
region=${CLOUD_RUN_REGION:-us-central1}
service=${CLOUD_RUN_SERVICE:-github-software-induction-service}
identifier=${ACTIVITYPUB_IDENTIFIER:-github-software-induction-service}
image_repository="${region}-docker.pkg.dev/${GOOGLE_CLOUD_PROJECT}/capability-cells/${service}"
runtime_service_account=${CLOUD_RUN_SERVICE_ACCOUNT:-github-software-induction@${GOOGLE_CLOUD_PROJECT}.iam.gserviceaccount.com}
prepare_context=${PREPARE_CONTEXT_COMMAND:-$script_dir/prepare-context.sh}

[[ -x "$prepare_context" ]] || { echo "committed-context assembler is unavailable" >&2; exit 69; }

activitypub_origin=$(node --input-type=module - "$ACTIVITYPUB_ORIGIN" <<'NODE'
const input = process.argv[2];
let url;
try { url = new URL(input); } catch { process.exit(64); }
if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password || url.hostname.endsWith(".invalid")) process.exit(64);
process.stdout.write(url.origin);
NODE
) || { echo "ACTIVITYPUB_ORIGIN must be a stable canonical HTTPS origin, never .invalid" >&2; exit 64; }

repository_root=$(git -C "$script_dir" rev-parse --show-toplevel)
actuator_module="$repository_root/services/web-services-section/services/web-platform-services-section/services/cloud-services-section/services/gcloud-services-section/services/gcloud-cloud-run-actuator-service/src/gcloud-cloud-run-actuator.mjs"
for command in gcloud node; do command -v "$command" >/dev/null || { echo "missing required command: $command" >&2; exit 69; }; done
if [[ -n "${ACTUATOR_CLI:-}" ]]; then command -v "$ACTUATOR_CLI" >/dev/null || { echo "ACTUATOR_CLI bootstrap override is unavailable" >&2; exit 69; }
else
  actuator_bin="$repository_root/services/web-services-section/services/web-platform-services-section/services/cloud-services-section/services/gcloud-services-section/services/gcloud-cloud-run-actuator-service/scripts/gcloud-cloud-run-actuator.mjs"
  [[ -f "$actuator_bin" ]] || { echo "checked-in Cloud Run actuator CLI is absent" >&2; exit 69; }
fi
tag=${BUILD_TAG:-$(git -C "$script_dir" rev-parse --verify HEAD)}
revision_tag=$(node --input-type=module - "$actuator_module" "$service" "$tag" <<'NODE'
import { createHash } from "node:crypto"; import { pathToFileURL } from "node:url";
const [modulePath, service, source] = process.argv.slice(2); const { CLOUD_RUN_TAGGED_ROUTE_LIMITS: limits } = await import(pathToFileURL(modulePath).href);
const tag = `s-${createHash("sha256").update(source).digest("hex").slice(0, 6)}`;
if (service.length + tag.length > limits.maxServiceAndTagCharacters) process.exit(64); process.stdout.write(tag);
NODE
) || { echo "Cloud Run service leaves no valid deterministic staging-tag budget" >&2; exit 64; }
build_image="${image_repository}:${tag}"

context_dir=$(mktemp -d /tmp/github-software-induction-cloud-build.XXXXXXXX)
trap 'rm -rf -- "$context_dir"' EXIT
"$prepare_context" "$context_dir"
gcloud builds submit "$context_dir" --project "$GOOGLE_CLOUD_PROJECT" \
  --config "$context_dir/cloudbuild.yaml" --substitutions "_IMAGE_URI=$build_image"
image_digest=$(gcloud artifacts docker images describe "$build_image" --project "$GOOGLE_CLOUD_PROJECT" --format='value(image_summary.digest)')
[[ "$image_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Cloud Build image digest is not one sha256 digest" >&2; exit 65; }
image="${image_repository}@${image_digest}"
export REVISION_TAG="$revision_tag"

stage_request=$(node --input-type=module - "$GOOGLE_CLOUD_PROJECT" "$region" "$service" "$image" "$runtime_service_account" "$activitypub_origin" <<'NODE'
const [project, region, service, image, serviceAccount, origin] = process.argv.slice(2);
const environment = {
  HOST: "0.0.0.0", GOOGLE_CLOUD_PROJECT: project, BASE_URL: origin, ACTIVITYPUB_ORIGIN: origin, ACTIVITYPUB_IDENTIFIER: "github-software-induction-service",
  ACTIVITYPUB_KEYS_PATH: "/secrets/activitypub/keys.json", CLOUDFLARE_R2_ACCOUNT_ID: process.env.CLOUDFLARE_R2_ACCOUNT_ID,
  CLOUDFLARE_R2_BUCKET: process.env.CLOUDFLARE_R2_BUCKET, CLOUD_TASKS_LOCATION: process.env.CLOUD_TASKS_LOCATION,
  CLOUD_TASKS_QUEUE: process.env.CLOUD_TASKS_QUEUE, CLOUD_TASKS_SERVICE_ACCOUNT: process.env.CLOUD_TASKS_SERVICE_ACCOUNT,
  GCS_OPERATION_BUCKET: process.env.GCS_OPERATION_BUCKET, GCS_OPERATION_PREFIX: process.env.GCS_OPERATION_PREFIX, AGENT_CARD_SIGNING_KEY: "/secrets/a2a-key/signing-key.pem",
  AGENT_CARD_JWKS: "/secrets/a2a-jwks/jwks.json", AGENT_CARD_SIGNING_KID: "github-software-induction-service-ed25519-2026-10-21", AGENT_CARD_SIGNING_ALG: "EdDSA",
};
const secretBindings = {
  "/secrets/activitypub/keys.json": "github-software-induction-activitypub-keys:latest",
  "/secrets/a2a-key/signing-key.pem": "github-software-induction-signing-key:latest",
  "/secrets/a2a-jwks/jwks.json": "github-software-induction-jwks:latest",
  GITHUB_SERVICES_TOKEN: "github-software-induction-token:latest", API_KEY_CLOUDFLARE_R2_EDIT: "cloudflare-r2-api-token:latest",
};
process.stdout.write(JSON.stringify({ operation: "deploy-cloud-run-service", project, region, service, image, revisionTag: process.env.REVISION_TAG, allowUnauthenticated: true, serviceAccount, environment, secretBindings, concurrency: 4, cpu: "2", memory: "2Gi", timeoutSeconds: 900, maxInstances: 2 }));
NODE
)
actuate() { if [[ -n "${ACTUATOR_CLI:-}" ]]; then printf '%s' "$1" | "$ACTUATOR_CLI"; else printf '%s' "$1" | node "$actuator_bin"; fi; }
stage_receipt=$(actuate "$stage_request")
revision=$(printf '%s' "$stage_receipt" | node --input-type=module -e 'let source="";process.stdin.on("data",(c)=>source+=c).on("end",()=>{const record=JSON.parse(source);const revision=record?.receipt?.object?.content?.revision;if(typeof revision!=="string"||revision==="")process.exit(65);process.stdout.write(revision)})')
tag_url=$(printf '%s' "$stage_receipt" | node --input-type=module -e 'let source="";process.stdin.on("data",(c)=>source+=c).on("end",()=>{const record=JSON.parse(source);const url=record?.receipt?.object?.content?.tagUrl;if(typeof url!=="string"||!url.startsWith("https://"))process.exit(65);process.stdout.write(url.replace(/\/$/,""))})')
node --input-type=module - "$tag_url" "$activitypub_origin" "$identifier" <<'NODE'
const [tagUrl, origin, identifier] = process.argv.slice(2);
const actor = await fetch(`${tagUrl}/actors/${identifier}`, { headers: { accept: "application/activity+json" } });
if (!actor.ok) throw new Error(`staged actor probe failed with HTTP ${actor.status}`);
const document = await actor.json();
if (document?.type !== "Service" || document?.id !== `${origin}/actors/${identifier}`) throw new Error("staged actor does not project the canonical ActivityPub Service identity");
const card = await fetch(`${tagUrl}/.well-known/agent-card.json`, { headers: { accept: "application/json" } });
if (!card.ok || !Array.isArray((await card.json())?.signatures)) throw new Error("staged signed agent card is absent");
const worker = await fetch(`${tagUrl}/_private/github-induction-worker`, { method: "POST" });
if (worker.status !== 401) throw new Error(`staged private worker did not fail closed (HTTP ${worker.status})`);
NODE
cutover_request=$(node --input-type=module - "$GOOGLE_CLOUD_PROJECT" "$region" "$service" "$revision" "$activitypub_origin" <<'NODE'
const [project, region, service, revision, canonicalOrigin] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ operation: "cutover-cloud-run-service", project, region, service, revision, canonicalOrigin }));
NODE
)
actuate "$cutover_request" >/dev/null
printf 'origin=%s\nimage=%s\nrevision=%s\n' "$activitypub_origin" "$image" "$revision"
