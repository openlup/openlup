import {
  dispatchIdempotencyKey,
  isOmnipackDispatchContactStale,
  type OmnipackDispatchCandidate,
  type OmnipackDispatchJobConfig,
  type OmnipackDispatchJobResult,
  type OmnipackDispatchPort,
  type OmnipackProviderClient,
} from "./omnipackDispatchContracts.js";
import { omnipackDispatchAcceptanceKeys } from "./omnipackDispatchAcceptance.js";
import {
  acceptedProviderProof,
  acknowledgeAcceptedDispatch,
  providerEffectMayHaveSucceeded,
  recoverDispatchAcceptanceWrite,
  safeReason,
  sanitizeDispatchError,
} from "./omnipackDispatchError.js";
import {
  buildOmnipackDispatchCommand,
  buildOmnipackDispatchPayloadFromCandidate,
  buildSanitizedEvidence,
} from "./omnipackDispatchPayload.js";

export {
  dispatchIdempotencyKey, OMNIPACK_DISPATCH_CONTACT_STALE, readOmnipackDispatchBatchLimit,
  readOmnipackDispatchMode, type OmnipackDispatchCandidate, type OmnipackDeliveryContactSnapshot,
  type OmnipackDispatchAcceptanceResult, type OmnipackDispatchContactPreparation, type OmnipackDispatchJobResult, type OmnipackDispatchMode,
  type OmnipackDispatchPort, type OmnipackDispatchReadBack, type OmnipackDispatchRefResult,
  type OmnipackDispatchRefStatus, type OmnipackDispatchSubmissionResult,
} from "./omnipackDispatchContracts.js";
export { buildOmnipackDispatchPayloadFromCandidate, buildSanitizedEvidence } from "./omnipackDispatchPayload.js";

export async function runOmnipackDispatchWorker(input: {
  port: OmnipackDispatchPort;
  providerClient: OmnipackProviderClient | null;
  config: OmnipackDispatchJobConfig;
}): Promise<OmnipackDispatchJobResult> {
  const result: OmnipackDispatchJobResult = {
    ok: true, skipped: false,
    checked: 0, updated: 0, failures: 0,
    mode: input.config.mode,
    replayed: 0, providerCalls: 0, readBacks: 0,
  };

  if (input.config.mode !== "shadow") {
    try {
      await input.port.markStaleSubmissionsUncertain(new Date(Date.now() - 5 * 60_000).toISOString());
    } catch (error) {
      return {
        ...result,
        ok: false,
        failures: 1,
        reason: `omnipack_dispatch_stale_submission_sweep_failed:${safeReason(error)}`,
      };
    }
  }

  const candidates = await input.port.listCandidates(input.config.batchLimit);
  result.checked = candidates.length;

  candidateLoop: for (const candidate of candidates) {
    const idempotencyKey = dispatchIdempotencyKey(candidate.fulfillmentOrderId);

    try {
      let readBack = await input.port.readDispatchRefByIdempotencyKey(idempotencyKey);
      if (readBack) result.readBacks += 1;

      // Local convergence is not a provider side effect. This historical
      // incident repair closes label_created from accepted provider proof with
      // zero additional POSTs.
      if (acceptedProviderProof(readBack)) {
        const acknowledgement = await acknowledgeAcceptedDispatch({
          port: input.port,
          candidate,
          readBack,
          sanitizedRequest: readBack.sanitized_request,
          source: "omnipack_dispatch_worker_recovery",
        });
        if (acknowledgement.replayed) result.replayed += 1;
        result.updated += acknowledgement.replayed ? 0 : 1;
        continue;
      }

      const preparation = await input.port.prepareDispatchContact(candidate.fulfillmentOrderId);
      if (preparation.disposition === "withheld") continue;
      const preparedCandidate = await input.port.readCandidateByFulfillmentOrderId(candidate.fulfillmentOrderId);
      if (!preparedCandidate) throw new Error("omnipack_dispatch_prepared_candidate_missing");

      if (input.config.mode !== "shadow" && !input.providerClient) {
        result.ok = false;
        result.failures += 1;
        result.reason = result.reason ?? "omnipack_provider_not_configured";
        continue;
      }

      let mappedCandidate = preparedCandidate;
      let dispatchRef: Awaited<ReturnType<OmnipackDispatchPort["recordDispatchRef"]>>;
      let providerPayload: Record<string, unknown>;
      let sanitizedRequest: Record<string, unknown>;
      let requestFingerprint: string;
      let mappedAttemptCount = 0;

      for (let remapCount = 0; ; remapCount += 1) {
        const dispatchCommand = buildOmnipackDispatchCommand(mappedCandidate);
        providerPayload = dispatchCommand.providerPayload as unknown as Record<string, unknown>;
        sanitizedRequest = dispatchCommand.sanitizedRequest;
        requestFingerprint = dispatchCommand.requestFingerprint;

        try {
          dispatchRef = await input.port.recordDispatchRef({
            idempotencyKey,
            fulfillmentOrderId: mappedCandidate.fulfillmentOrderId,
            providerOrderId: null,
            dispatchMode: input.config.mode,
            status: "draft",
            requestFingerprint,
            sanitizedRequest,
            sanitizedResponse: {},
            error: {},
          });
        } catch (error) {
          if (remapCount === 0 && isOmnipackDispatchContactStale(error)) {
            const refreshed = await input.port.readCandidateByFulfillmentOrderId(candidate.fulfillmentOrderId);
            if (!refreshed) throw new Error("omnipack_dispatch_contact_remap_candidate_missing");
            mappedCandidate = refreshed;
            continue;
          }
          throw error;
        }
        if (dispatchRef.replayed) result.replayed += 1;

        // A correctable draft can atomically refresh both its fingerprint and
        // its redacted evidence, so the post-recorder readback is authoritative.
        readBack = await input.port.readDispatchRefByIdempotencyKey(idempotencyKey);
        if (readBack) result.readBacks += 1;
        if (!readBack || readBack.fulfillment_order_id !== mappedCandidate.fulfillmentOrderId) {
          throw new Error("omnipack_dispatch_readback_failed");
        }

        await recordMappedProviderAttempt(
          input.port,
          mappedCandidate,
          idempotencyKey,
          sanitizedRequest,
          input.config,
          mappedAttemptCount,
        );
        mappedAttemptCount += 1;

        if (input.config.mode === "shadow") {
          result.updated += dispatchRef.replayed ? 0 : 1;
          continue candidateLoop;
        }

        // `failed`, `uncertain`, and in-flight `submitting` are terminal for the
        // automatic POST rail. They require provider lookup/reconciliation or a
        // reviewed manual decision; blindly posting again could create a second
        // physical fulfillment.
        if (readBack.status !== "draft") {
          result.ok = false;
          result.failures += 1;
          result.reason = result.reason ?? `omnipack_dispatch_not_safe_to_submit:${readBack.status}`;
          continue candidateLoop;
        }

        let submission;
        try {
          submission = await input.port.beginSubmission({
            dispatchRefId: dispatchRef.dispatchRefId,
            requestFingerprint,
          });
        } catch (error) {
          if (remapCount === 0 && isOmnipackDispatchContactStale(error)) {
            const refreshed = await input.port.readCandidateByFulfillmentOrderId(candidate.fulfillmentOrderId);
            if (!refreshed) throw new Error("omnipack_dispatch_contact_remap_candidate_missing");
            mappedCandidate = refreshed;
            continue;
          }
          throw error;
        }
        if (!submission.begun) {
          const concurrentReadBack = await input.port.readDispatchRefByIdempotencyKey(idempotencyKey);
          if (concurrentReadBack) result.readBacks += 1;
          if (acceptedProviderProof(concurrentReadBack)) {
            const acknowledgement = await acknowledgeAcceptedDispatch({
              port: input.port,
              candidate: mappedCandidate,
              readBack: concurrentReadBack,
              sanitizedRequest: concurrentReadBack.sanitized_request,
              source: "omnipack_dispatch_worker_concurrent_recovery",
            });
            if (acknowledgement.replayed) result.replayed += 1;
            result.updated += acknowledgement.replayed ? 0 : 1;
          } else {
            result.replayed += 1;
          }
          continue candidateLoop;
        }
        if (submission.status !== "submitting") {
          throw new Error(`omnipack_dispatch_submission_state_invalid:${submission.status}`);
        }

        break;
      }

      // Count the physical effect attempt before awaiting it so timeouts and
      // network failures remain visible as provider calls.
      result.providerCalls += 1;
      let providerResponse: { providerOrderId: string };
      try {
        providerResponse = await input.providerClient!.createOrder(providerPayload!);
      } catch (error) {
        const mayHaveSucceeded = providerEffectMayHaveSucceeded(error);
        await input.port.finalizeSubmission({
          dispatchRefId: dispatchRef.dispatchRefId,
          providerOrderId: null,
          mayHaveSucceeded,
          sanitizedResponse: {},
          error: sanitizeDispatchError(error),
        });
        result.ok = false;
        result.failures += 1;
        result.reason = result.reason ?? safeReason(error);
        continue;
      }

      const sanitizedResponse = {
        provider: "omnipack",
        providerOrderId: providerResponse.providerOrderId,
      };
      try {
        const acceptanceKeys = omnipackDispatchAcceptanceKeys(mappedCandidate.fulfillmentOrderId);
        const acknowledgement = await input.port.acknowledgeDispatchAcceptance({
          dispatchRefId: dispatchRef.dispatchRefId,
          providerOrderId: providerResponse.providerOrderId,
          ...acceptanceKeys,
          sanitizedRequest,
          sanitizedResponse,
          metadata: {
            source: "omnipack_dispatch_worker",
            mode: input.config.mode,
            proof: "provider_accepted_atomic_label_ack",
          },
        });
        if (acknowledgement.replayed) result.replayed += 1;
      } catch (error) {
        const recovery = await recoverDispatchAcceptanceWrite({
          port: input.port,
          requestIdempotencyKey: idempotencyKey,
          dispatchRefId: dispatchRef.dispatchRefId,
          providerOrderId: providerResponse.providerOrderId,
          sanitizedResponse,
          error,
        });
        result.readBacks += recovery.readBacks;
        if (recovery.committed) {
          result.updated += 1;
          continue;
        }
        result.ok = false;
        result.failures += 1;
        result.reason = result.reason ?? "omnipack_dispatch_proof_write_failed_after_provider_acceptance";
        break;
      }
      result.updated += 1;
    } catch (error) {
      result.ok = false;
      result.failures += 1;
      result.reason = result.reason ?? safeReason(error);
    }
  }

  return result;
}

async function recordMappedProviderAttempt(
  port: OmnipackDispatchPort,
  candidate: OmnipackDispatchCandidate,
  idempotencyKey: string,
  sanitizedRequest: Record<string, unknown>,
  config: OmnipackDispatchJobConfig,
  mappedAttemptIndex: number,
): Promise<void> {
  await port.recordProviderAttempt({
    idempotencyKey: mappedAttemptIndex === 0
      ? `${idempotencyKey}:attempt`
      : `${idempotencyKey}:attempt:contact-remap`,
    fulfillmentOrderId: candidate.fulfillmentOrderId,
    status: "recorded",
    requestPayload: sanitizedRequest,
    responsePayload: {},
    error: null,
    metadata: {
      source: "omnipack_dispatch_worker",
      mode: config.mode,
      shadowMode: config.mode === "shadow",
    },
  });
}
