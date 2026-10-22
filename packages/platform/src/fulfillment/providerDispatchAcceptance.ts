import type { DispatchRecord, FulfillmentDispatchResult, FulfillmentStorePort } from "./contracts/index.js";
import { dispatchEvidence } from "./dispatchProjection.js";

export function acknowledgeAcceptedDispatch(input: {
  store: FulfillmentStorePort;
  record: DispatchRecord & { externalRef: string };
  keys: { providerAttemptKey: string; labelKey: string };
}) {
  return input.store.acknowledge({ dispatchRef: input.record.dispatchRef, acceptance: {
    kind: "accepted", externalRef: input.record.externalRef, evidence: dispatchEvidence(input.record.evidence), ...input.keys,
  } });
}

export async function recoverDispatchAcceptanceWrite(input: {
  store: FulfillmentStorePort; requestKey: string; dispatchRef: string;
  acceptance: Extract<FulfillmentDispatchResult, { kind: "accepted" }>;
}): Promise<{ committed: boolean; readBacks: number }> {
  let record = await input.store.read(input.requestKey).catch(() => null);
  let readBacks = record ? 1 : 0;
  const committed = () => record?.status === "created" && record.externalRef === input.acceptance.externalRef;
  if (committed()) return { committed: true, readBacks };
  try {
    // Accepted proof survives a failed atomic ACK; finalization records uncertainty,
    // and the next worker repairs the ACK locally without another provider call.
    record = await input.store.finalize({ dispatchRef: input.dispatchRef, result: input.acceptance });
    readBacks += 1;
  } catch {
    // Submitting remains fenced; the stale sweep moves it to uncertain.
  }
  return { committed: committed(), readBacks };
}
