import { createCloudTasksMessageQueue, createGcsTransactionalOperationStore, createGoogleApiRequest, createGoogleOidcVerifier } from "@red-cup-engineering/gcloud-runtime-authorities-service";
import { createImmutableContentCustody } from "@red-cup-engineering/immutable-content-custody-service";

function requiredEnvironment(environment, name) {
  const value = environment[name];
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${name} is required for GitHub induction production runtime`);
  return value;
}

function canonicalOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new TypeError("ACTIVITYPUB_ORIGIN must be one canonical HTTPS origin"); }
  if (url.protocol !== "https:" || url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
    throw new TypeError("ACTIVITYPUB_ORIGIN must be one canonical HTTPS origin");
  }
  return url.origin;
}

/**
 * Materializes the only production runtime for the GitHub induction worker.
 * Cloud Tasks owns authenticated retrial; GCS owns CAS; immutable R2 custody
 * carries Fedify messages by NI.  This service supplies no process-local
 * queue, operation store, or content fallback.
 */
export function createGithubInductionProductionRuntime(options = {}) {
  const environment = options.environment ?? process.env;
  const origin = canonicalOrigin(requiredEnvironment(environment, "ACTIVITYPUB_ORIGIN"));
  const project = requiredEnvironment(environment, "GOOGLE_CLOUD_PROJECT");
  const location = requiredEnvironment(environment, "CLOUD_TASKS_LOCATION");
  const queueName = requiredEnvironment(environment, "CLOUD_TASKS_QUEUE");
  const serviceAccountEmail = requiredEnvironment(environment, "CLOUD_TASKS_SERVICE_ACCOUNT");
  const operationBucket = requiredEnvironment(environment, "GCS_OPERATION_BUCKET");
  const targetUrl = new URL("/_private/github-induction-worker", origin).href;
  const request = (options.createGoogleApiRequest ?? createGoogleApiRequest)(options.googleApiRequestOptions);
  const immutable = (options.createImmutableContentCustody ?? createImmutableContentCustody)(options.immutableContentCustodyOptions);
  if (!immutable || typeof immutable.put !== "function" || typeof immutable.get !== "function") throw new TypeError("immutable content custody must expose put and get");
  const custody = Object.freeze({
    retain: ({ identity, mediaType, bytes }) => immutable.put({ ni: identity, mediaType, bytes }),
    async retrieve(identity) {
      const retained = await immutable.get(identity);
      return retained === null || retained === undefined ? undefined : retained.bytes;
    },
  });
  const authenticate = (options.createGoogleOidcVerifier ?? createGoogleOidcVerifier)({
    audience: targetUrl,
    serviceAccountEmail,
    ...(options.oidcVerifierOptions ?? {}),
  });
  const queue = (options.createCloudTasksMessageQueue ?? createCloudTasksMessageQueue)({
    project, location, queue: queueName, targetUrl, audience: targetUrl, serviceAccountEmail,
    request, custody, authenticate,
  });
  const operationStore = (options.createGcsTransactionalOperationStore ?? createGcsTransactionalOperationStore)({
    bucket: operationBucket,
    ...(environment.GCS_OPERATION_PREFIX === undefined ? {} : { prefix: environment.GCS_OPERATION_PREFIX }),
    request,
  });
  return Object.freeze({ origin, targetUrl, queue, operationStore });
}
