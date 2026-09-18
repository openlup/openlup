import type {
  SubscriberMessageIntent,
  SubscriberPersonalizationFacts,
  SubscriberProfile,
  SubscriberRetentionPort,
  SubscriberRetentionRefusal,
  SubscriptionAutoResumePort,
} from "../../domains/subscription/subscriberRetention.js";

export interface SubscriberRetentionRoutineClient {
  rpc(name: string, args: Record<string, unknown>): Promise<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
}

/** Named direct-Postgres adapter; all policy and replay decisions stay in SQL. */
export function createPostgresSubscriberRetentionPort(
  client: SubscriberRetentionRoutineClient,
): SubscriberRetentionPort & SubscriptionAutoResumePort {
  return {
    async run(limit) {
      const row = object(await call(client, "subscription_auto_resume_due", { p_limit: limit }),
        "subscriber auto resume response invalid");
      return {
        ok: row.ok !== false,
        scanned: integer(row, "scanned"),
        resumed: integer(row, "resumed"),
        skippedRows: integer(row, "skippedRows"),
        failed: integer(row, "failed"),
        reason: optional(row, "reason") ?? undefined,
      };
    },
    async upsertProfile({ profile, facts, fingerprint }) {
      return replay(await call(client, "subscriber_profile_upsert", {
        p_subject_reference: profile.subjectReference,
        p_display_name: profile.displayName,
        p_locale: profile.locale,
        p_revision: profile.revision,
        p_display_facts: facts.displayFacts,
        p_capabilities: facts.capabilities,
        p_fingerprint: fingerprint,
      }));
    },

    async createIntent(input) {
      return intent(await call(client, "subscriber_retention_create_intent", {
        p_idempotency_key: input.idempotencyKey,
        p_subject_reference: input.subjectReference,
        p_subscription_id: input.subscriptionId,
        p_source_reference: input.sourceReference,
        p_kind: input.kind,
        p_template_reference: input.templateReference,
        p_fingerprint: input.fingerprint,
        p_expected_revision: input.expectedRevision,
        p_recipient_fingerprint: input.recipientFingerprint,
        p_control_key: input.controlKey,
        p_consent_purpose: input.consentPurpose,
      }));
    },

    async recordDelivery(input) {
      return intent(await call(client, "subscriber_retention_record_delivery", {
        p_idempotency_key: input.idempotencyKey,
        p_fingerprint: input.fingerprint,
        p_state: input.state,
        p_delivery_reference: input.deliveryReference,
        p_attempt_count: input.attemptCount,
        p_claim_reference: input.claimReference,
      }));
    },

    async readProfile(subjectReference) {
      const data = await call(client, "subscriber_profile_read", {
        p_subject_reference: subjectReference,
      });
      if (data === null) return null;
      const row = object(data, "subscriber profile response invalid");
      const profile: SubscriberProfile = {
        subjectReference: required(row, "subjectReference"),
        displayName: optional(row, "displayName"),
        locale: optional(row, "locale"),
        revision: integer(row, "revision"),
      };
      const facts: SubscriberPersonalizationFacts = {
        subjectReference: profile.subjectReference,
        displayFacts: stringRecord(row.displayFacts),
        capabilities: stringList(row.capabilities),
        locale: profile.locale,
        revision: profile.revision,
      };
      return { profile, facts };
    },

    async readIntent(intentId) {
      const data = await call(client, "subscriber_retention_read_intent", { p_intent_id: intentId });
      return data === null ? null : intent(data);
    },
    async planDue(kind, limit) {
      const row = object(await call(client, "subscriber_retention_plan_due", {
        p_kind: kind,
        p_limit: limit,
      }), "subscriber retention plan response invalid");
      return {
        scanned: integer(row, "scanned"),
        planned: integer(row, "planned"),
        refused: integer(row, "refused"),
        replayed: integer(row, "replayed"),
      };
    },
    async claimIntent(idempotencyKey, fingerprint) {
      const data = await call(client, "subscriber_retention_claim_intent", {
        p_idempotency_key: idempotencyKey,
        p_fingerprint: fingerprint,
      });
      return data === null ? null : pending(data);
    },
    async listPending(kind, limit) {
      const data = await call(client, "subscriber_retention_list_pending", {
        p_kind: kind,
        p_limit: limit,
      });
      if (!Array.isArray(data)) throw new Error("subscriber retention pending response invalid");
      return data.map(pending);
    },
  };
}

async function call(
  client: SubscriberRetentionRoutineClient,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const { data, error } = await client.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message ?? `${name}_failed`), { code: error.code });
  return data;
}

function replay(value: unknown): { replayed: boolean } {
  return { replayed: object(value, "subscriber profile response invalid").replayed === true };
}

function intent(value: unknown): SubscriberMessageIntent {
  const row = object(value, "subscriber retention response invalid");
  const status = required(row, "status");
  if (!(["planned", "dispatching", "accepted", "failed", "refused"] as const).includes(status as never)) {
    throw new Error("subscriber retention response invalid");
  }
  const refusal = optional(row, "refusal") as SubscriberRetentionRefusal | null;
  return {
    intentId: required(row, "intentId"),
    subjectReference: required(row, "subjectReference"),
    subscriptionId: optional(row, "subscriptionId"),
    sourceReference: required(row, "sourceReference"),
    accessGrantReference: optional(row, "accessGrantReference"),
    kind: required(row, "kind") as SubscriberMessageIntent["kind"],
    templateReference: required(row, "templateReference"),
    fingerprint: required(row, "fingerprint"),
    status: status as SubscriberMessageIntent["status"],
    refusal,
    deliveryReference: optional(row, "deliveryReference"),
    attemptCount: integer(row, "attemptCount"),
    replayed: row.replayed === true,
  };
}

function pending(value: unknown) {
  const row = object(value, "subscriber retention pending response invalid");
  return {
    idempotencyKey: required(row, "idempotencyKey"),
    subjectReference: required(row, "subjectReference"),
    kind: required(row, "kind") as SubscriberMessageIntent["kind"],
    templateReference: required(row, "templateReference"),
    accessGrantReference: optional(row, "accessGrantReference"),
    fingerprint: required(row, "fingerprint"),
    claimReference: required(row, "dispatchClaimReference"),
  };
}

function object(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as Record<string, unknown>;
}

function required(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  if (typeof field !== "string" || !field) throw new Error("subscriber retention response invalid");
  return field;
}

function optional(value: Record<string, unknown>, key: string): string | null {
  const field = value[key];
  return typeof field === "string" && field ? field : null;
}

function integer(value: Record<string, unknown>, key: string): number {
  const field = value[key];
  if (typeof field !== "number" || !Number.isSafeInteger(field) || field < 0) {
    throw new Error("subscriber retention response invalid");
  }
  return field;
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
  const row = object(value, "subscriber profile response invalid");
  if (Object.values(row).some((entry) => typeof entry !== "string")) {
    throw new Error("subscriber profile response invalid");
  }
  return row as Record<string, string>;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("subscriber profile response invalid");
  }
  return value;
}
