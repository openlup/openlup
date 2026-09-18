import { describe, expect, it, vi } from "vitest";

import { CommunicationUnavailableError } from "../../src/domains/communications/ports.js";
import {
  createCommunicationsControlPlanePort,
  isCommunicationsOperatorActive,
  settleCommunicationsControlPlaneSend,
} from "./communicationsControlPlane.js";

const OPERATOR = "11111111-1111-4111-8111-111111111111";
const AT = "2026-08-13T12:00:00.000Z";
const request = {
  recipientId: "opaque-recipient",
  templateSlug: "opaque-template",
  idempotencyKey: "communications-send-1",
};

describe("communications control-plane routines", () => {
  it("prepares, captures and atomically records an accepted neutral send", async () => {
    const query = vi.fn(async (sql: string, _values?: unknown[]) => {
      if (sql.includes("prepare_delivery_command")) return { rows: [{ action: "proceed", attempt_count: 1 }] };
      if (sql.includes("record_delivery_accepted")) return { rows: [receipt("accepted")] };
      throw new Error(`unexpected SQL ${sql}`);
    });
    const deliver = vi.fn(async () => ({ deliveryReference: "captured:delivery-1" }));
    const port = createCommunicationsControlPlanePort({ query }, {
      operatorId: OPERATOR,
      capturedDelivery: { deliver },
    });

    await expect(port.sendEmail(request)).resolves.toEqual({ message: {
      id: "captured:delivery-1",
      channel: "email",
      recipientId: "opaque-recipient",
      templateSlug: "opaque-template",
      status: "sent",
      provider: null,
      providerMessageId: null,
      skippedReason: null,
    } });
    expect(deliver).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]?.[1]).toEqual([
      OPERATOR,
      "communications-send-1",
      expect.stringMatching(/^[a-f0-9]{64}$/),
      "opaque-template",
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(query.mock.calls[1]?.[1]).toEqual([
      OPERATOR, "communications-send-1", expect.stringMatching(/^[a-f0-9]{64}$/), "captured:delivery-1",
    ]);
  });

  it("replays an accepted receipt without another captured attempt", async () => {
    const query = vi.fn(async (sql: string) => sql.includes("prepare_delivery_command")
      ? { rows: [{ action: "replayed", attempt_count: 1 }] }
      : { rows: [receipt("accepted")] });
    const deliver = vi.fn();
    const port = createCommunicationsControlPlanePort({ query }, {
      operatorId: OPERATOR, capturedDelivery: { deliver },
    });

    await expect(port.sendEmail(request)).resolves.toMatchObject({ message: { id: "captured:delivery-1" } });
    expect(deliver).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("returns failure as data after recording a sanitized failed receipt", async () => {
    const query = vi.fn(async (sql: string, _params?: unknown[]) => {
      if (sql.includes("prepare_delivery_command")) return { rows: [{ action: "proceed", attempt_count: 1 }] };
      if (sql.includes("record_delivery_failed")) return { rows: [receipt("failed")] };
      throw new Error("unexpected query");
    });
    const settled = await settleCommunicationsControlPlaneSend({ query }, {
      operatorId: OPERATOR,
      capturedDelivery: { deliver: vi.fn(async () => { throw new Error("raw transport detail"); }) },
    }, request);

    expect(settled).toEqual({ ok: false, error: expect.any(CommunicationUnavailableError) });
    expect(query).toHaveBeenLastCalledWith(
      expect.stringContaining("record_delivery_failed"),
      [OPERATOR, "communications-send-1", expect.stringMatching(/^[a-f0-9]{64}$/), "captured_delivery_failed"],
    );
  });

  it("requires idempotency and maps policy conflict before capture", async () => {
    const deliver = vi.fn();
    const port = createCommunicationsControlPlanePort({ query: vi.fn() }, {
      operatorId: OPERATOR, capturedDelivery: { deliver },
    });
    await expect(port.sendEmail({ recipientId: "recipient", templateSlug: "template" }))
      .rejects.toMatchObject({ name: "CommunicationValidationError" });

    const conflict = createCommunicationsControlPlanePort({
      query: vi.fn(async () => { throw Object.assign(new Error("private"), { code: "23505" }); }),
    }, { operatorId: OPERATOR, capturedDelivery: { deliver } });
    await expect(conflict.sendEmail(request)).rejects.toMatchObject({ name: "CommunicationConflictError" });
    expect(deliver).not.toHaveBeenCalled();
  });

  it("maps neutral operations, control state, evidence, health and readiness", async () => {
    const query = vi.fn(async (sql: string) => {
      if (sql.includes("list_delivery_operations")) return { rows: [{
        ...receipt("accepted"), template_reference: "opaque-template",
        recipient_fingerprint: "a".repeat(64), created_at: AT, updated_at: AT, total_count: "1",
      }] };
      if (sql.includes("list_delivery_controls")) return { rows: [{ control_key: "delivery", enabled: true, revision: 2, updated_at: AT }] };
      if (sql.includes("list_delivery_templates")) return { rows: [{ template_reference: "opaque-template", control_key: "delivery", active: true, revision: 3, updated_at: AT }] };
      if (sql.includes("delivery_health")) return { rows: [{ attempted: "1", accepted: "1", failed: "0" }] };
      if (sql.includes("delivery_readiness")) return { rows: [{ required_control_count: "1", disabled_control_keys: [] }] };
      if (sql.includes("list_delivery_events")) return { rows: [{
        event_id: "1", idempotency_key: request.idempotencyKey, transition: "accepted",
        attempt_count: 1, operator_id: OPERATOR, occurred_at: new Date(AT),
      }] };
      if (sql.includes("set_delivery_control")) return { rows: [{ communications_set_delivery_control: 4 }] };
      throw new Error(`unexpected SQL ${sql}`);
    });
    const port = createCommunicationsControlPlanePort({ query }, {
      operatorId: OPERATOR, capturedDelivery: { deliver: vi.fn() },
    });

    await expect(port.getDeliveryOperations({ page: 0, pageSize: 25 })).resolves.toMatchObject({
      totalCount: 1,
      operations: [{ idempotencyKey: request.idempotencyKey, state: "accepted" }],
      controls: [{ controlKey: "delivery", revision: 2 }],
      templates: [{ templateReference: "opaque-template", revision: 3 }],
      health: { attempted: 1, accepted: 1, failed: 0 },
      readiness: { requiredControlCount: 1, disabledControlKeys: [] },
    });
    await expect(port.getDeliveryOperationEvents({ idempotencyKey: request.idempotencyKey }))
      .resolves.toMatchObject({ events: [{ eventId: "1", occurredAt: AT }] });
    await expect(port.mutateDeliveryControl({ action: "set-control", controlKey: "delivery", enabled: true }))
      .resolves.toEqual({ updated: true, revision: 4 });
  });

  it("exposes the exact operator allowlist checker without trusting caller role data", async () => {
    const query = vi.fn(async () => ({ rows: [{ communications_operator_is_active: true }] }));
    await expect(isCommunicationsOperatorActive({ query }, OPERATOR)).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("communications_operator_is_active"), [OPERATOR]);
  });
});

function receipt(state: "accepted" | "failed") {
  return {
    idempotency_key: request.idempotencyKey,
    command_fingerprint: "f".repeat(64),
    state,
    delivery_reference: state === "accepted" ? "captured:delivery-1" : null,
    error_code: state === "failed" ? "captured_delivery_failed" : null,
    attempt_count: 1,
  };
}
