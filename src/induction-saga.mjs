export const STATES = Object.freeze(["received", "admitted", "materialized", "verified", "publication-attempted", "bound", "refused", "publication-uncertain", "response-delivered"]);
const TERMINAL = new Set(["bound", "refused", "publication-uncertain", "response-delivered"]);
const errorBody = (error) => ({ name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error) });

/**
 * Durable operation-store contract, supplied by the cloud/on-chain boundary:
 *   get(operation) -> immutable current record or null
 *   compareAndSet(operation, expectedVersion|null, record) -> stored record
 *
 * `compareAndSet` must reject a stale expectedVersion and return a record with
 * its new opaque `version`.  This service deliberately supplies no filesystem
 * fallback: local state is not an authority for a cloud induction operation.
 */
function assertStore(store) {
  if (!store || typeof store.get !== "function" || typeof store.compareAndSet !== "function") {
    throw new Error("GitHub induction requires an injected durable operation store with get and compareAndSet");
  }
}
function pending(record) { return new Error(`GitHub induction operation is already ${record.state}; its admitted owner must resume or reconcile it`); }

export async function executeInductionSaga(request, { induce, provider = {}, operationStore } = {}) {
  if (typeof request?.id !== "string" || request.id === "") throw new Error("induction saga requires the exact RMN request identity");
  if (typeof induce !== "function") throw new Error("induction saga requires an induction operation");
  assertStore(operationStore);
  const key = request.id;
  let saga = await operationStore.get(key);
  const transition = async (state, extra = {}) => {
    const next = { version: undefined, operation: key, state, input: request.input, updatedAt: new Date().toISOString(), ...saga, ...extra, state };
    saga = await operationStore.compareAndSet(key, saga?.version ?? null, next);
    if (!saga || saga.operation !== key || saga.state !== state || saga.version === undefined) throw new Error("durable operation store returned an invalid transition record");
    return saga;
  };
  if (!saga) {
    try { await transition("received"); } catch (error) { saga = await operationStore.get(key); if (!saga) throw error; }
  }
  if (saga.operation !== key) throw new Error("induction saga coordinate collision");
  if (saga.result && TERMINAL.has(saga.state)) return saga.result;
  if (saga.state === "publication-attempted") {
    const target = request.input?.target ?? { repository: request.input?.source?.repository, ref: "heads/main" };
    try {
      const head = await provider.api?.getRef?.(target.repository, target.ref.slice("heads/".length));
      const commit = head && await provider.api?.getCommit?.(target.repository, head), marker = `RMN-Request: ${key}`;
      if (commit?.message?.includes(marker) && (target.create || commit.parents?.some((parent) => (parent.sha ?? parent) === request.input?.source?.commit))) {
        const result = Object.freeze({ disposition: "bound", provider: "urn:ame:github-software-induction-service", operation: key, repository: target.repository, ref: target.ref, priorCommit: target.create ? null : request.input.source.commit, commit: head, recovered: true });
        await transition("bound", { result }); return result;
      }
    } catch (error) { await transition("publication-uncertain", { error: errorBody(error) }); throw error; }
    const error = new Error("GitHub publication outcome is uncertain; refusing to rerun mutation"); await transition("publication-uncertain", { error: errorBody(error) }); throw error;
  }
  if (saga.state !== "received") throw pending(saga);
  // This CAS is the admission ownership claim. A concurrent delivery that loses
  // it cannot reach the GitHub mutation and must observe/retry the owner.
  try { await transition("admitted"); } catch (error) { saga = await operationStore.get(key); if (saga?.state !== "admitted") throw error; throw pending(saga); }
  try {
    const result = await induce(request.input, { ...provider, operationKey: key, onState: async (state) => { await transition(state); } });
    const correlated = Object.freeze({ ...result, operation: key }); await transition("bound", { result: correlated }); return correlated;
  } catch (error) { if (saga.state !== "publication-attempted") await transition("refused", { error: errorBody(error) }); throw error; }
}

export async function markInductionResponseDelivered(requestId, { operationStore } = {}) {
  assertStore(operationStore);
  const saga = await operationStore.get(requestId);
  if (!saga || saga.operation !== requestId || !saga.result) throw new Error("cannot mark an unknown induction response delivered");
  return operationStore.compareAndSet(requestId, saga.version, { ...saga, version: undefined, state: "response-delivered", updatedAt: new Date().toISOString() });
}
