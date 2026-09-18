import {
  CommerceFulfillmentConflictError,
  CommerceFulfillmentPersistenceError,
  type ShipmentSpineMutationPort,
  type ShipmentSpineResult,
} from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import type { PgQueryExecutor } from "./queryBuilder.js";

const CONTRACT_VERSION = "platform.fulfillment.shipment.v1";

const CREATE_SHIPMENT_SQL = `
  WITH existing_operation AS (
    SELECT 1 AS found
    FROM public.fulfillment_shipment_operations
    WHERE idempotency_key = $1::text || ':operation'
  ), configured_port AS (
    SELECT port_key
    FROM public.fulfillment_ports
    WHERE port_key = $3::text
      AND routable IS TRUE
      AND ($6::text IS NULL OR provider_type = $6::text)
  )
  SELECT
    CASE WHEN configured_port.port_key IS NULL AND existing_operation.found IS NULL THEN NULL
      ELSE public.fulfillment_create_shipment(
        $1::text, $2::uuid, $3::text, $4::jsonb, COALESCE($5::timestamptz, now())
      )
    END AS response,
    configured_port.port_key IS NOT NULL OR existing_operation.found IS NOT NULL AS port_ready
  FROM (SELECT (SELECT port_key FROM configured_port LIMIT 1) AS port_key) configured_port
  CROSS JOIN (SELECT (SELECT found FROM existing_operation LIMIT 1) AS found) existing_operation`;

const ADVANCE_SHIPMENT_SQL = `
  SELECT public.fulfillment_advance_shipment(
    $1::text, $2::uuid, $3::text, $4::jsonb, COALESCE($5::timestamptz, now())
  ) AS response`;

const RECORD_EVIDENCE_SQL = `
  SELECT public.fulfillment_record_evidence(
    $1::text, $2::uuid, $3::text, $4::text, $5::text, $6::jsonb,
    COALESCE($7::timestamptz, now())
  ) AS response`;

const CANCEL_SHIPMENT_SQL = `
  SELECT public.fulfillment_cancel_shipment(
    $1::text, $2::uuid, $3::text, $4::jsonb, COALESCE($5::timestamptz, now())
  ) AS response`;

const RAISE_EXCEPTION_SQL = `
  SELECT public.fulfillment_raise_shipment_exception(
    $1::text, $2::uuid, $3::text, $4::jsonb, COALESCE($5::timestamptz, now())
  ) AS response`;

export interface PostgresFulfillmentShipmentSpineOptions {
  portKey: string;
  evidenceChannel?: "poll" | "push";
  requiredProviderType?: "simulator";
}

/** Direct node-postgres adapter for the provider-neutral public shipment rail. */
export function createPostgresFulfillmentShipmentSpinePort(
  executor: PgQueryExecutor,
  options: PostgresFulfillmentShipmentSpineOptions,
): ShipmentSpineMutationPort {
  const portKey = options.portKey.trim();
  if (!portKey) throw new Error("fulfillment_shipment_spine_port_key_required");
  const evidenceChannel = options.evidenceChannel;
  if (evidenceChannel !== undefined && evidenceChannel !== "poll" && evidenceChannel !== "push") {
    throw new Error("fulfillment_shipment_spine_evidence_channel_invalid");
  }

  const advance = (
    idempotencyKey: string,
    shipmentId: string,
    status: string,
    metadata: Record<string, unknown> | undefined,
    requestedAt: string | undefined,
  ) => call(executor, ADVANCE_SHIPMENT_SQL, [
    idempotencyKey,
    shipmentId,
    status,
    metadata ?? {},
    requestedAt ?? null,
  ]);

  const evidence = (
    idempotencyKey: string,
    shipmentId: string,
    role: "label" | "tracking",
    externalRef: string | undefined,
    metadata: Record<string, unknown> | undefined,
    requestedAt: string | undefined,
  ): Promise<ShipmentSpineResult> | null => {
    if (!evidenceChannel || !externalRef) return null;
    return call(executor, RECORD_EVIDENCE_SQL, [
      idempotencyKey,
      shipmentId,
      evidenceChannel,
      role,
      externalRef,
      metadata ?? {},
      requestedAt ?? null,
    ]);
  };

  return {
    createShipment(request) {
      return callCreate(executor, portKey, [
        request.idempotencyKey,
        request.orderId,
        portKey,
        request.metadata ?? {},
        request.requestedAt ?? null,
        options.requiredProviderType ?? null,
      ]);
    },

    async recordLabel(request) {
      await advance(
        `${request.idempotencyKey}:packed`,
        request.shipmentId,
        "packed",
        request.metadata,
        request.requestedAt,
      );
      await advance(
        `${request.idempotencyKey}:label-pending`,
        request.shipmentId,
        "label_pending",
        request.metadata,
        request.requestedAt,
      );
      const labelled = await advance(
        `${request.idempotencyKey}:label-created`,
        request.shipmentId,
        "label_created",
        request.metadata,
        request.requestedAt,
      );
      return await evidence(
        `${request.idempotencyKey}:label-evidence`,
        request.shipmentId,
        "label",
        request.externalRef,
        request.metadata,
        request.requestedAt,
      ) ?? labelled;
    },

    handOff(request) {
      return advance(
        request.idempotencyKey,
        request.shipmentId,
        "handed_over",
        request.metadata,
        request.requestedAt,
      );
    },

    async recordTracking(request) {
      // Evidence precedes the transition because the public rail correctly
      // closes evidence ingestion once a shipment reaches `delivered`.
      await evidence(
        `${request.idempotencyKey}:tracking-evidence`,
        request.shipmentId,
        "tracking",
        request.externalRef,
        request.metadata,
        request.requestedAt,
      );
      return advance(
        request.idempotencyKey,
        request.shipmentId,
        request.status,
        request.metadata,
        request.requestedAt,
      );
    },

    cancel(request) {
      return call(executor, CANCEL_SHIPMENT_SQL, [
        request.idempotencyKey,
        request.shipmentId,
        request.reason,
        request.metadata ?? {},
        request.requestedAt ?? null,
      ]);
    },

    raiseException(request) {
      return call(executor, RAISE_EXCEPTION_SQL, [
        request.idempotencyKey,
        request.shipmentId,
        request.reason,
        request.metadata ?? {},
        request.requestedAt ?? null,
      ]);
    },
  };
}

async function callCreate(
  executor: PgQueryExecutor,
  portKey: string,
  values: unknown[],
): Promise<ShipmentSpineResult> {
  try {
    const result = await executor.query(CREATE_SHIPMENT_SQL, values);
    const row = asRecord(result.rows[0]);
    if (row?.port_ready !== true) {
      throw new CommerceFulfillmentConflictError("fulfillment_port_not_ready", {
        reason: "fulfillment_port_not_ready",
        portKey,
      });
    }
    return parseResponse(row.response);
  } catch (error) {
    if (error instanceof CommerceFulfillmentConflictError
      || error instanceof CommerceFulfillmentPersistenceError) throw error;
    throw mapPostgresError(error);
  }
}

async function call(
  executor: PgQueryExecutor,
  sql: string,
  values: unknown[],
): Promise<ShipmentSpineResult> {
  try {
    const result = await executor.query(sql, values);
    return parseResponse(asRecord(result.rows[0])?.response);
  } catch (error) {
    if (error instanceof CommerceFulfillmentPersistenceError) throw error;
    throw mapPostgresError(error);
  }
}

function parseResponse(input: unknown): ShipmentSpineResult {
  const response = asRecord(input);
  const shipment = asRecord(response?.shipment);
  if (
    response?.contractVersion !== CONTRACT_VERSION
    || typeof shipment?.id !== "string"
    || typeof shipment.orderId !== "string"
    || typeof shipment.status !== "string"
    || typeof response.replayed !== "boolean"
  ) {
    throw new CommerceFulfillmentPersistenceError("Fulfillment shipment spine response invalid");
  }
  return {
    shipmentId: shipment.id,
    orderId: shipment.orderId,
    status: shipment.status,
    replayed: response.replayed,
  };
}

function mapPostgresError(error: unknown): Error {
  const value = asRecord(error);
  const code = typeof value?.code === "string" ? value.code : undefined;
  const message = typeof value?.message === "string" ? value.message : "";
  if (code === "22023" || code === "23505") {
    return new CommerceFulfillmentConflictError("Fulfillment shipment spine conflict", {
      code,
      reason: classifyConflictReason(message),
    });
  }
  return new CommerceFulfillmentPersistenceError("Fulfillment shipment spine persistence failed", { code });
}

function classifyConflictReason(message: string): string {
  if (message.includes("fulfillment_create_shipment_order_not_fulfillable")) return "order_not_fulfillable";
  if (message.includes("fulfillment_advance_shipment_archetype_forbids_handover")) return "handover_without_label";
  if (message.includes("fulfillment_advance_shipment_invalid_transition")) return "invalid_transition";
  if (message.includes("fulfillment_cancel_shipment_invalid_status")) return "cancel_after_label";
  if (message.includes("idempotency_conflict")) return "idempotency_conflict";
  return "fulfillment_conflict";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}
