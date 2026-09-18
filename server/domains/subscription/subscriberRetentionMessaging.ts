import { createHash } from "node:crypto";

import type {
  SubscriberMessageIntent,
  SubscriberPersonalizationFacts,
  SubscriberProfile,
  SubscriberRetentionPort,
  SubscriptionAutoResumePort,
} from "./subscriberRetention.js";
export interface SubscriberDeliveryAction {
  send(command: {
    idempotencyKey: string;
    recipientReference: string;
    templateReference: string;
    accessGrantReference?: string;
  }): Promise<SubscriberDeliveryReceipt>;
  readReceipt(idempotencyKey: string): Promise<SubscriberDeliveryReceipt | null>;
}

interface SubscriberDeliveryReceipt {
  state: "accepted" | "failed";
  deliveryReference: string | null;
  attemptCount: number;
}

export interface SubscriberRetentionMessaging {
  upsertProfile(input: {
    profile: SubscriberProfile;
    facts: SubscriberPersonalizationFacts;
  }): Promise<{ replayed: boolean }>;
  deliverIntent(input: {
    idempotencyKey: string;
    subjectReference: string;
    subscriptionId: string | null;
    sourceReference: string;
    kind: SubscriberMessageIntent["kind"];
    templateReference: string;
    expectedRevision: number;
    recipientFingerprint: string;
    controlKey: string;
    consentPurpose: string | null;
  }): Promise<SubscriberMessageIntent>;
  readProfile: SubscriberRetentionPort["readProfile"];
  readIntent: SubscriberRetentionPort["readIntent"];
  autoResumeDue(limit: number): ReturnType<SubscriptionAutoResumePort["run"]>;
  dispatchPending(
    kind: SubscriberMessageIntent["kind"],
    limit: number,
  ): Promise<{ ok: boolean; scanned: number; accepted: number; failed: number }>;
  planAndDispatch(
    kind: SubscriberMessageIntent["kind"],
    limit: number,
  ): Promise<{
    ok: boolean;
    scanned: number;
    planned: number;
    refused: number;
    replayed: number;
    accepted: number;
    failed: number;
  }>;
}

/**
 * Final runtime owner for subscriber-retention messaging. Policy authorization
 * is durable in the retention port; delivery and replay use the already-shipped
 * Communications receipt rail. No message body or provider identifier crosses
 * this boundary.
 */
export function createSubscriberRetentionMessaging(deps: {
  retention: SubscriberRetentionPort & SubscriptionAutoResumePort;
  delivery: SubscriberDeliveryAction;
}): SubscriberRetentionMessaging {
  return {
    upsertProfile({ profile, facts }) {
      if (facts.subjectReference !== profile.subjectReference
        || facts.revision !== profile.revision
        || facts.locale !== profile.locale) {
        throw new Error("subscriber_profile_facts_mismatch");
      }
      return deps.retention.upsertProfile({
        profile,
        facts,
        fingerprint: digest({ profile, facts }),
      });
    },

    async deliverIntent(input): Promise<SubscriberMessageIntent> {
      const fingerprint = intentFingerprint(input);
      const intent = await deps.retention.createIntent({ ...input, fingerprint });
      if (intent.status === "accepted" || intent.status === "refused") return intent;
      const claimed = await deps.retention.claimIntent(input.idempotencyKey, fingerprint);
      if (!claimed) return (await deps.retention.readIntent(intent.intentId)) ?? intent;

      try {
        const receipt = await deps.delivery.send({
          idempotencyKey: claimed.idempotencyKey,
          recipientReference: claimed.subjectReference,
          templateReference: claimed.templateReference,
          ...(claimed.accessGrantReference ? { accessGrantReference: claimed.accessGrantReference } : {}),
        });
        return deps.retention.recordDelivery({
          idempotencyKey: input.idempotencyKey,
          fingerprint,
          state: receipt.state,
          deliveryReference: receipt.deliveryReference,
          attemptCount: receipt.attemptCount,
          claimReference: claimed.claimReference,
        });
      } catch (error) {
        const receipt = await deps.delivery.readReceipt(input.idempotencyKey).catch(() => null);
        if (receipt?.state === "failed") {
          return deps.retention.recordDelivery({
            idempotencyKey: input.idempotencyKey,
            fingerprint,
            state: "failed",
            deliveryReference: null,
            attemptCount: receipt.attemptCount,
            claimReference: claimed.claimReference,
          });
        }
        throw error;
      }
    },

    readProfile: deps.retention.readProfile.bind(deps.retention),
    readIntent: deps.retention.readIntent.bind(deps.retention),
    autoResumeDue: deps.retention.run.bind(deps.retention),
    async planAndDispatch(kind, limit) {
      const plan = await deps.retention.planDue(kind, limit);
      const dispatch = await dispatchPending(deps, kind, limit);
      if (kind === "review_request") {
        const effectsPlan = await deps.retention.planDue("review_effects", limit);
        const effectsDispatch = await dispatchPending(deps, "review_effects", limit);
        return {
          ok: dispatch.ok && effectsDispatch.ok,
          scanned: plan.scanned + effectsPlan.scanned,
          planned: plan.planned + effectsPlan.planned,
          refused: plan.refused + effectsPlan.refused,
          replayed: plan.replayed + effectsPlan.replayed,
          accepted: dispatch.accepted + effectsDispatch.accepted,
          failed: dispatch.failed + effectsDispatch.failed,
        };
      }
      return { ...plan, ...dispatch, scanned: plan.scanned, ok: dispatch.ok };
    },
    async dispatchPending(kind, limit) {
      return dispatchPending(deps, kind, limit);
    },
  };
}

async function dispatchPending(
  deps: Parameters<typeof createSubscriberRetentionMessaging>[0],
  kind: SubscriberMessageIntent["kind"],
  limit: number,
) {
  const pending = await deps.retention.listPending(kind, limit);
  const result = { ok: true, scanned: pending.length, accepted: 0, failed: 0 };
  for (const intent of pending) {
    try {
      const receipt = await deps.delivery.send({
        idempotencyKey: intent.idempotencyKey,
        recipientReference: intent.subjectReference,
        templateReference: intent.templateReference,
        ...(intent.accessGrantReference ? { accessGrantReference: intent.accessGrantReference } : {}),
      });
      const recorded = await deps.retention.recordDelivery({
        idempotencyKey: intent.idempotencyKey,
        fingerprint: intent.fingerprint,
        state: receipt.state,
        deliveryReference: receipt.deliveryReference,
        attemptCount: receipt.attemptCount,
        claimReference: intent.claimReference,
      });
      if (recorded.status === "accepted") result.accepted += 1;
      else result.failed += 1;
    } catch {
      const receipt = await deps.delivery.readReceipt(intent.idempotencyKey).catch(() => null);
      if (receipt?.state === "failed") {
        await deps.retention.recordDelivery({
          idempotencyKey: intent.idempotencyKey,
          fingerprint: intent.fingerprint,
          state: "failed",
          deliveryReference: null,
          attemptCount: receipt.attemptCount,
          claimReference: intent.claimReference,
        });
        result.failed += 1;
        continue;
      }
      result.ok = false;
      result.failed += 1;
    }
  }
  return result;
}

function intentFingerprint(input: {
  subjectReference: string;
  subscriptionId: string | null;
  sourceReference: string;
  kind: SubscriberMessageIntent["kind"];
  templateReference: string;
  expectedRevision: number;
  recipientFingerprint: string;
  controlKey: string;
  consentPurpose: string | null;
}): string {
  return digest({
    subjectReference: input.subjectReference,
    subscriptionId: input.subscriptionId,
    sourceReference: input.sourceReference,
    kind: input.kind,
    templateReference: input.templateReference,
    expectedRevision: input.expectedRevision,
    recipientFingerprint: input.recipientFingerprint,
    controlKey: input.controlKey,
    consentPurpose: input.consentPurpose,
  });
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
