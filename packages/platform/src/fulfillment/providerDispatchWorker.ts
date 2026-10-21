import type { DispatchRecord, FulfillmentDispatchPort, FulfillmentDispatchRequest, FulfillmentStorePort } from "./contracts/index.js";
import { acceptedProviderProof, dispatchEvidence, dispatchResult } from "./dispatchProjection.js";
import { acknowledgeAcceptedDispatch, recoverDispatchAcceptanceWrite } from "./providerDispatchAcceptance.js";
import { unknownDispatchFailure } from "./providerDispatchError.js";

export async function runFulfillmentDispatchWorker(input: {
  store: FulfillmentStorePort;
  provider: FulfillmentDispatchPort | null;
  listCandidates(limit: number): Promise<readonly FulfillmentDispatchRequest[]>;
  /** Return the original host key bytes, without a new package prefix. */
  keys: {
    request(candidate: FulfillmentDispatchRequest): string;
    mappedAttempt(requestKey: string, mappedAttemptIndex: number): string;
    acceptance(fulfillmentRef: string): { providerAttemptKey: string; labelKey: string };
  };
  config: { mode: DispatchRecord["mode"]; batchLimit: number };
  now?: () => Date;
}) {
  const result = { ok: true, skipped: false, checked: 0, updated: 0, failures: 0,
    mode: input.config.mode, replayed: 0, providerCalls: 0, readBacks: 0, reason: undefined as string | undefined };
  if (input.config.mode !== "shadow") {
    try { await input.store.markStaleSubmissionsUncertain(new Date((input.now?.() ?? new Date()).getTime() - 5 * 60_000).toISOString()); }
    catch { return { ...result, ok: false, failures: 1, reason: "dispatch_stale_submission_sweep_failed" }; }
  }
  const candidates = await input.listCandidates(input.config.batchLimit);
  result.checked = candidates.length;
  candidateLoop: for (const candidate of candidates) {
    const requestKey = input.keys.request(candidate);
    try {
      let readBack = await input.store.read(requestKey);
      if (readBack) result.readBacks += 1;
      if (acceptedProviderProof(readBack)) {
        const ack = await acknowledgeAcceptedDispatch({ store: input.store, record: readBack, keys: input.keys.acceptance(candidate.fulfillmentRef) });
        if (ack.replayed) result.replayed += 1;
        result.updated += ack.replayed ? 0 : 1;
        continue;
      }
      const preparation = await input.store.prepare(candidate.fulfillmentRef);
      if (preparation.disposition === "withheld") continue;
      const preparedCandidate = await input.store.readCandidate(candidate.fulfillmentRef);
      if (!preparedCandidate) throw new Error("dispatch_prepared_candidate_missing");
      if (input.config.mode !== "shadow" && !input.provider) {
        result.ok = false; result.failures += 1; result.reason ??= "provider_not_configured"; continue;
      }
      // Shadow needs command preparation too, but never calls dispatch.
      if (!input.provider) throw new Error("provider_command_preparation_not_configured");
      let mappedCandidate = preparedCandidate;
      let dispatchRef: DispatchRecord;
      let evidence: DispatchRecord["evidence"];
      let mappedAttemptCount = 0;
      for (let remapCount = 0; ; remapCount += 1) {
        const request = { ...mappedCandidate, requestKey };
        const prepared = await input.provider.prepare(request);
        if (prepared.kind === "refused") {
          result.ok = false; result.failures += 1; result.reason ??= prepared.refusal.reason; continue candidateLoop;
        }
        evidence = dispatchEvidence(prepared.evidence);
        const claim = await input.store.claim({ requestKey, fulfillmentRef: mappedCandidate.fulfillmentRef,
          orderRef: mappedCandidate.orderRef, parcelRef: mappedCandidate.parcelRef, mode: input.config.mode, evidence });
        if (claim.kind === "refused") {
          if (remapCount === 0 && claim.refusal.reason === "contact_stale") {
            const refreshed = await input.store.readCandidate(candidate.fulfillmentRef);
            if (!refreshed) throw new Error("dispatch_contact_remap_candidate_missing");
            mappedCandidate = refreshed; continue;
          }
          result.ok = false; result.failures += 1; result.reason ??= claim.refusal.reason; continue candidateLoop;
        }
        dispatchRef = claim.record;
        if (dispatchRef.replayed) result.replayed += 1;
        // Re-claim may refresh a correctable draft atomically; readback is authoritative.
        readBack = await input.store.read(requestKey);
        if (readBack) result.readBacks += 1;
        if (!readBack || readBack.fulfillmentRef !== mappedCandidate.fulfillmentRef) throw new Error("dispatch_readback_failed");
        await input.store.recordProviderAttempt(input.keys.mappedAttempt(requestKey, mappedAttemptCount),
          mappedCandidate.fulfillmentRef, evidence, input.config.mode, "recorded");
        mappedAttemptCount += 1;
        if (input.config.mode === "shadow") {
          result.updated += dispatchRef.replayed ? 0 : 1; continue candidateLoop;
        }
        if (readBack.status !== "draft") {
          result.ok = false; result.failures += 1; result.reason ??= `dispatch_not_safe_to_submit:${readBack.status}`; continue candidateLoop;
        }
        const submission = await input.store.begin({ dispatchRef: dispatchRef.dispatchRef, commandFingerprint: evidence.commandFingerprint });
        if (submission.kind === "refused") {
          if (remapCount === 0 && submission.refusal.reason === "contact_stale") {
            const refreshed = await input.store.readCandidate(candidate.fulfillmentRef);
            if (!refreshed) throw new Error("dispatch_contact_remap_candidate_missing");
            mappedCandidate = refreshed; continue;
          }
          result.ok = false; result.failures += 1; result.reason ??= submission.refusal.reason; continue candidateLoop;
        }
        if (!submission.begun) {
          const concurrent = await input.store.read(requestKey);
          if (concurrent) result.readBacks += 1;
          if (acceptedProviderProof(concurrent)) {
            const ack = await acknowledgeAcceptedDispatch({ store: input.store, record: concurrent, keys: input.keys.acceptance(mappedCandidate.fulfillmentRef) });
            if (ack.replayed) result.replayed += 1;
            result.updated += ack.replayed ? 0 : 1;
          } else { result.replayed += 1; }
          continue candidateLoop;
        }
        if (submission.record.status !== "submitting") throw new Error("dispatch_submission_state_invalid");
        break;
      }
      result.providerCalls += 1;
      let response;
      try { response = dispatchResult(await input.provider.dispatch({ ...mappedCandidate, requestKey }, evidence)); }
      catch { response = unknownDispatchFailure(); }
      if (response.kind !== "accepted") {
        await input.store.finalize({ dispatchRef: dispatchRef.dispatchRef, result: response });
        result.ok = false; result.failures += 1; result.reason ??= response.refusal.reason; continue;
      }
      // All ACK paths use the original host keys, ignoring adapter key fields.
      const acceptance = { ...response, ...input.keys.acceptance(mappedCandidate.fulfillmentRef) };
      try {
        const ack = await input.store.acknowledge({ dispatchRef: dispatchRef.dispatchRef, acceptance });
        if (ack.replayed) result.replayed += 1;
      } catch {
        const recovery = await recoverDispatchAcceptanceWrite({ store: input.store, requestKey, dispatchRef: dispatchRef.dispatchRef, acceptance });
        result.readBacks += recovery.readBacks;
        if (recovery.committed) { result.updated += 1; continue; }
        result.ok = false; result.failures += 1; result.reason ??= "dispatch_proof_write_failed_after_provider_acceptance"; break;
      }
      result.updated += 1;
    } catch {
      // Exception messages may contain raw provider bodies or credentials.
      result.ok = false; result.failures += 1; result.reason ??= "dispatch_local_operation_failed";
    }
  }
  return result;
}
