import { createHash } from "node:crypto";

import type {
  CommunicationsDeliveryOperationsResponse,
  SendEmailRequest,
  SendEmailResponse,
} from "../../src/domains/communications/contracts.js";
import {
  CommunicationConflictError,
  CommunicationUnavailableError,
  CommunicationValidationError,
  type CommunicationControlPlanePort,
} from "../../src/domains/communications/ports.js";
import type {
  CapturedTransactionalDeliveryPort,
  TransactionalDeliveryCommand,
} from "../../src/domains/communications/transactionalDeliveryPort.js";
import { COMMUNICATION_CHANNEL } from "../../src/domains/communications/types.js";
import type { PgQueryExecutor } from "./postgres/queryBuilder.js";

type Options = {
  operatorId: string;
  capturedDelivery: CapturedTransactionalDeliveryPort;
};

export type CommunicationsSendSettlement =
  | { ok: true; response: SendEmailResponse }
  | { ok: false; error: CommunicationUnavailableError };

const rpc = (name: string, parameters: string[]) =>
  `SELECT * FROM public.${name}(${parameters.map((value, index) => `$${index + 1}::${value}`).join(", ")})`;

export const communicationsControlPlaneSql = {
  active: rpc("communications_operator_is_active", ["uuid"]),
  setControl: rpc("communications_set_delivery_control", ["uuid", "text", "boolean"]),
  setTemplate: rpc("communications_set_delivery_template", ["uuid", "text", "text", "boolean"]),
  prepare: rpc("communications_prepare_delivery_command", ["uuid", "text", "text", "text", "text"]),
  accepted: rpc("communications_record_delivery_accepted", ["uuid", "text", "text", "text"]),
  failed: rpc("communications_record_delivery_failed", ["uuid", "text", "text", "text"]),
  receipt: "SELECT * FROM public.transactional_delivery_receipts WHERE idempotency_key = $1::text",
  operations: rpc("communications_list_delivery_operations", ["uuid", "integer", "integer"]),
  events: rpc("communications_list_delivery_events", ["uuid", "text"]),
  controls: rpc("communications_list_delivery_controls", ["uuid"]),
  templates: rpc("communications_list_delivery_templates", ["uuid"]),
  health: rpc("communications_delivery_health", ["uuid"]),
  readiness: rpc("communications_delivery_readiness", ["uuid"]),
} as const;

const SQL = communicationsControlPlaneSql;

/** Shared routines over one caller-owned transaction/query executor. */
export function createCommunicationsControlPlanePort(
  client: PgQueryExecutor,
  options: Options,
): CommunicationControlPlanePort {
  return {
    async sendEmail(request) {
      const settled = await settleCommunicationsControlPlaneSend(client, options, request);
      if (settled.ok === false) throw settled.error;
      return settled.response;
    },

    async mutateDeliveryControl(request) {
      try {
        const result = request.action === "set-control"
          ? await client.query(SQL.setControl, [options.operatorId, request.controlKey, request.enabled])
          : await client.query(SQL.setTemplate, [
              options.operatorId, request.templateReference, request.controlKey, request.active,
            ]);
        const revision = integer(first(result.rows), "communications_control_revision_invalid");
        return { updated: true, revision };
      } catch (error) {
        throw mapError(error);
      }
    },

    async getDeliveryOperationEvents({ idempotencyKey }) {
      try {
        const { rows } = await client.query(SQL.events, [options.operatorId, idempotencyKey]);
        return { events: rows.map((row) => ({
          eventId: stringField(row, "event_id"),
          idempotencyKey: stringField(row, "idempotency_key"),
          transition: transition(row.transition),
          attemptCount: positiveInteger(row.attempt_count),
          operatorId: stringField(row, "operator_id"),
          occurredAt: timestamp(row.occurred_at),
        })) };
      } catch (error) {
        throw mapError(error);
      }
    },

    async getDeliveryOperations({ page, pageSize }) {
      try {
        const [operations, controls, templates, health, readiness] = await Promise.all([
          client.query(SQL.operations, [options.operatorId, page, pageSize]),
          client.query(SQL.controls, [options.operatorId]),
          client.query(SQL.templates, [options.operatorId]),
          client.query(SQL.health, [options.operatorId]),
          client.query(SQL.readiness, [options.operatorId]),
        ]);
        const healthRow = first(health.rows) ?? {};
        const readinessRow = first(readiness.rows) ?? {};
        return {
          operations: operations.rows.map(operation),
          totalCount: operations.rows.length === 0 ? 0 : nonnegativeInteger(operations.rows[0]?.total_count),
          controls: controls.rows.map((row) => ({
            controlKey: stringField(row, "control_key"), enabled: boolean(row.enabled),
            revision: positiveInteger(row.revision), updatedAt: timestamp(row.updated_at),
          })),
          templates: templates.rows.map((row) => ({
            templateReference: stringField(row, "template_reference"),
            controlKey: stringField(row, "control_key"), active: boolean(row.active),
            revision: positiveInteger(row.revision), updatedAt: timestamp(row.updated_at),
          })),
          health: {
            attempted: nonnegativeInteger(healthRow.attempted),
            accepted: nonnegativeInteger(healthRow.accepted),
            failed: nonnegativeInteger(healthRow.failed),
          },
          readiness: {
            requiredControlCount: nonnegativeInteger(readinessRow.required_control_count),
            disabledControlKeys: stringArray(readinessRow.disabled_control_keys),
          },
        } satisfies CommunicationsDeliveryOperationsResponse;
      } catch (error) {
        throw mapError(error);
      }
    },
  };
}

/** Return a named failure as data so the direct transaction can commit its failed receipt. */
export async function settleCommunicationsControlPlaneSend(
  client: PgQueryExecutor,
  options: Options,
  request: SendEmailRequest,
): Promise<CommunicationsSendSettlement> {
  if (!request.idempotencyKey) throw new CommunicationValidationError("communications_idempotency_key_required");
  const command: TransactionalDeliveryCommand = {
    idempotencyKey: request.idempotencyKey,
    recipientReference: request.recipientId,
    templateReference: request.templateSlug,
  };
  const commandFingerprint = digest(JSON.stringify({
    recipientReference: command.recipientReference,
    templateReference: command.templateReference,
  }));
  try {
    const prepared = first((await client.query(SQL.prepare, [
      options.operatorId, command.idempotencyKey, commandFingerprint,
      command.templateReference, digest(command.recipientReference),
    ])).rows);
    if (prepared?.action === "replayed") {
      const receipt = first((await client.query(SQL.receipt, [command.idempotencyKey])).rows);
      return { ok: true, response: sendResponse(request, receipt) };
    }
    if (prepared?.action !== "proceed") throw new CommunicationUnavailableError();

    let deliveryReference: string;
    try {
      ({ deliveryReference } = await options.capturedDelivery.deliver(command));
    } catch {
      return recordFailed(client, options.operatorId, command, commandFingerprint);
    }
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(deliveryReference)) {
      return recordFailed(client, options.operatorId, command, commandFingerprint);
    }
    const receipt = first((await client.query(SQL.accepted, [
      options.operatorId, command.idempotencyKey, commandFingerprint, deliveryReference,
    ])).rows);
    return { ok: true, response: sendResponse(request, receipt) };
  } catch (error) {
    throw mapError(error);
  }
}

async function recordFailed(
  client: PgQueryExecutor,
  operatorId: string,
  command: TransactionalDeliveryCommand,
  commandFingerprint: string,
): Promise<CommunicationsSendSettlement> {
  try {
    await client.query(SQL.failed, [
      operatorId, command.idempotencyKey, commandFingerprint, "captured_delivery_failed",
    ]);
  } catch {
    throw new CommunicationUnavailableError();
  }
  return { ok: false, error: new CommunicationUnavailableError() };
}

export async function isCommunicationsOperatorActive(client: PgQueryExecutor, principalId: string): Promise<boolean> {
  try {
    return first((await client.query(SQL.active, [principalId])).rows)?.communications_operator_is_active === true;
  } catch {
    throw new CommunicationUnavailableError();
  }
}

function sendResponse(request: SendEmailRequest, row: Record<string, unknown> | undefined): SendEmailResponse {
  if (row?.state !== "accepted" || typeof row.delivery_reference !== "string") {
    throw new CommunicationUnavailableError();
  }
  return { message: {
    id: row.delivery_reference, channel: COMMUNICATION_CHANNEL,
    recipientId: request.recipientId, templateSlug: request.templateSlug,
    status: "sent", provider: null, providerMessageId: null, skippedReason: null,
  } };
}

function operation(row: Record<string, unknown>) {
  return {
    idempotencyKey: stringField(row, "idempotency_key"),
    templateReference: stringField(row, "template_reference"),
    recipientFingerprint: stringField(row, "recipient_fingerprint"),
    state: row.state === "accepted" ? "accepted" as const : row.state === "failed" ? "failed" as const : invalid(),
    deliveryReference: nullableString(row.delivery_reference), errorCode: nullableString(row.error_code),
    attemptCount: positiveInteger(row.attempt_count), createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
  };
}

function mapError(error: unknown): Error {
  if (error instanceof CommunicationConflictError || error instanceof CommunicationValidationError
    || error instanceof CommunicationUnavailableError) return error;
  const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  if (code === "22023") return new CommunicationValidationError();
  if (code === "23505") return new CommunicationConflictError();
  return new CommunicationUnavailableError();
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const first = (rows: Record<string, unknown>[]) => rows[0];
const invalid = (): never => { throw new CommunicationUnavailableError(); };
const positiveInteger = (value: unknown) => Number.isInteger(Number(value)) && Number(value) > 0 ? Number(value) : invalid();
const nonnegativeInteger = (value: unknown) => Number.isInteger(Number(value)) && Number(value) >= 0 ? Number(value) : invalid();
const integer = (row: Record<string, unknown> | undefined, message: string) => row ? positiveInteger(Object.values(row)[0]) : (() => { throw new CommunicationUnavailableError(message); })();
const boolean = (value: unknown) => typeof value === "boolean" ? value : invalid();
const stringField = (row: Record<string, unknown>, key: string) => typeof row[key] === "string" && row[key] ? row[key] as string : invalid();
const nullableString = (value: unknown) => value === null ? null : typeof value === "string" && value ? value : invalid();
const stringArray = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string") ? value as string[] : invalid();
const timestamp = (value: unknown) => value instanceof Date ? value.toISOString() : typeof value === "string" && value ? value : invalid();
const transition = (value: unknown) => ["attempted", "accepted", "failed", "replayed"].includes(String(value))
  ? value as "attempted" | "accepted" | "failed" | "replayed" : invalid();
