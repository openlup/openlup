import {
  deriveStarterPhase,
  resolveDelivery2DiscountMinor,
  starterPackMarkerSchema,
  StarterPackMarkerError,
  type StarterPackCyclePort,
  type StarterPackCyclePreparation,
  type StarterPackCyclePreparationInput,
  type StarterPackMarker,
  type StarterPackState,
} from "../../../domains/subscription/starterPackCycle.js";

/**
 * Managed (Supabase) half of the starter-pack acquisition cycle.
 *
 * The marker is written once, by
 * `subscription_create_provisional_for_checkout`, and is immutable thereafter
 * (`subscriptions_starter_pack_immutable`). This file only reads it and drives
 * the graduation RPC, which is itself idempotent by construction; the phase
 * decision and the discount math stay in the domain.
 *
 * Deliberately fail-closed: a stored marker that does not parse THROWS rather
 * than degrading to "ordinary renewal".
 */

interface StarterStateQueryResult {
  data: unknown;
  error: { message?: string } | null;
}

interface StarterStateQueryBuilder extends PromiseLike<StarterStateQueryResult> {
  select(columns: string): StarterStateQueryBuilder;
  eq(column: string, value: unknown): StarterStateQueryBuilder;
}

export interface StarterPackDbClient {
  rpc(functionName: string, args: Record<string, unknown>): PromiseLike<StarterStateQueryResult>;
  from(table: string): StarterStateQueryBuilder;
}

/** The managed implementation of the domain's neutral cycle port. */
export function createStarterPackCyclePort(client: StarterPackDbClient): StarterPackCyclePort {
  return {
    loadStarterPackState: (subscriptionId) => loadStarterPackState(client, subscriptionId),
    prepareStarterPackCycle: (input) => prepareStarterPackCycle(client, input),
  };
}

/** The single `subscriptions` read the cycle builder adds. */
export async function loadStarterPackState(
  client: StarterPackDbClient,
  subscriptionId: string,
): Promise<StarterPackState> {
  const { data, error } = await client
    .from("subscriptions")
    .select("starter_pack, template_version, cadence_days")
    .eq("id", subscriptionId);
  if (error) {
    throw new StarterPackMarkerError(
      `subscriptions starter state read failed: ${error.message ?? "unknown"}`,
      subscriptionId,
    );
  }
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
  if (!row || typeof row !== "object") {
    throw new StarterPackMarkerError("subscription row not found", subscriptionId);
  }
  return {
    marker: parseStoredMarker(row.starter_pack, subscriptionId),
    templateVersion: Number(row.template_version ?? 0),
    cadenceDays: Number(row.cadence_days ?? 0),
  };
}

function parseStoredMarker(raw: unknown, subscriptionId: string): StarterPackMarker | null {
  if (raw === null || raw === undefined) return null;
  const parsed = starterPackMarkerSchema.safeParse(raw);
  if (!parsed.success) {
    throw new StarterPackMarkerError(
      `subscriptions.starter_pack failed schema validation: ${parsed.error.message}`,
      subscriptionId,
    );
  }
  return parsed.data;
}

const INERT: StarterPackCyclePreparation = {
  phase: "none",
  discountTotalGrossMinor: null,
  reload: false,
  provenance: null,
};

export async function prepareStarterPackCycle(
  client: StarterPackDbClient,
  input: StarterPackCyclePreparationInput,
): Promise<StarterPackCyclePreparation> {
  const { marker, templateVersion, cadenceDays } = input.state;
  const phase = deriveStarterPhase({
    marker,
    cycleNumber: input.cycleNumber,
    templateVersion,
    cadenceDays,
  });
  if (!marker || phase === "none") return INERT;

  if (phase === "delivery2") {
    const discountTotalGrossMinor = resolveDelivery2DiscountMinor({
      marker,
      templateVersion,
      subtotalMinor: input.subtotalMinor,
    });
    return {
      phase,
      discountTotalGrossMinor,
      reload: false,
      // No timestamp: dunning replays this cycle and must rebuild the same
      // pricing snapshot byte for byte.
      provenance: {
        starterPack: {
          reasonCode: "starter_pack_delivery_2",
          discountMinor: discountTotalGrossMinor,
          basisTemplateVersion: marker.basisTemplateVersion,
        },
      },
    };
  }

  const mode = phase === "graduate_full" ? "full" : "cadence_only";
  const reason = await applyGraduation(client, input.subscriptionId, marker, mode);

  // TOCTOU recovery. The phase came from a template_version read older than the
  // RPC's own `FOR UPDATE` read, so a customer edit can land in between; the RPC
  // then rightly refuses to overwrite their mix, but does NOT touch cadence,
  // leaving a full steady package renewing at the starter interval (as little as
  // 7 days) until the next cycle catches it. The decision below is taken on a
  // FRESH read via the same predicate, which the RPC re-checks under its own
  // lock, so a customer who already chose a normal cadence is left alone.
  if (mode === "full" && reason === "template_version_moved") {
    const fresh = await loadStarterPackState(client, input.subscriptionId);
    const freshPhase = deriveStarterPhase({
      marker: fresh.marker,
      cycleNumber: input.cycleNumber,
      templateVersion: fresh.templateVersion,
      cadenceDays: fresh.cadenceDays,
    });
    if (fresh.marker && freshPhase === "graduate_cadence_only") {
      await applyGraduation(client, input.subscriptionId, fresh.marker, "cadence_only");
    }
  }
  return { phase, discountTotalGrossMinor: null, reload: true, provenance: null };
}

/**
 * Declined outcomes the RPC reports as DATA, both meaning "nothing to do". Every
 * other decline (invalid input or mode, open payment cycle, invalid cadence or
 * lines) RAISEs and arrives as a transport error.
 */
const GRADUATION_PROCEED_REASONS = new Set(["cadence_already_normal", "not_a_starter_subscription"]);

/**
 * One graduation call. Returns the declined reason, or `null` when it applied. A
 * transport error still throws: a failed graduation must not degrade into an
 * ordinary renewal.
 */
async function applyGraduation(
  client: StarterPackDbClient,
  subscriptionId: string,
  marker: StarterPackMarker,
  mode: "full" | "cadence_only",
): Promise<string | null> {
  const keyPrefix = mode === "full" ? "starter-graduation" : "starter-cadence-normalize";
  const { data, error } = await client.rpc("subscription_apply_starter_graduation", {
    p_subscription_id: subscriptionId,
    p_idempotency_key: `${keyPrefix}:${subscriptionId}:${marker.basisTemplateVersion}`,
    p_mode: mode,
  });
  if (error) {
    throw new StarterPackMarkerError(
      `subscription_apply_starter_graduation failed: ${error.message ?? "unknown"}`,
      subscriptionId,
    );
  }
  return declinedReason(data);
}

/**
 * `null` unless the RPC explicitly reported `applied: false`. An unreadable body
 * counts as applied (the pre-fix behaviour), so an unknown future reason
 * degrades to the one-cycle self-heal, not to a throw or a wrong write.
 */
function declinedReason(data: unknown): string | null {
  const row = (data as { starterGraduation?: Record<string, unknown> } | null)?.starterGraduation;
  if (!row || typeof row !== "object" || row.applied !== false) return null;
  const reason = typeof row.reason === "string" ? row.reason : null;
  return reason !== null && GRADUATION_PROCEED_REASONS.has(reason) ? null : reason;
}
