import { describe, expect, it, vi } from "vitest";

import { createPostgresCommunicationsControlPlanePort } from "./communicationsControlPlane.js";

const OPERATOR = "11111111-1111-4111-8111-111111111111";

describe("Postgres communications control-plane binding", () => {
  it("commits the failed receipt before surfacing sanitized unavailable", async () => {
    const statements: Array<{ text: string; values?: unknown[] }> = [];
    const release = vi.fn();
    const end = vi.fn(async () => undefined);
    const client = {
      async query(text: string, values?: unknown[]) {
        statements.push({ text, values });
        if (text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK") return { rows: [] };
        if (text.includes("prepare_delivery_command")) return { rows: [{ action: "proceed", attempt_count: 1 }] };
        if (text.includes("record_delivery_failed")) return { rows: [{ state: "failed" }] };
        throw new Error(`unexpected SQL ${text}`);
      },
      release,
    };
    const pool = { connect: vi.fn(async () => client), end };
    const port = createPostgresCommunicationsControlPlanePort(
      { connectionString: "postgres://platform" },
      {
        operatorId: OPERATOR,
        poolFactory: () => pool as never,
        capturedFactory: () => ({ deliver: vi.fn(async () => { throw new Error("provider details"); }) }),
      },
    );

    await expect(port.sendEmail({
      recipientId: "opaque-recipient",
      templateSlug: "opaque-template",
      idempotencyKey: "communications-send-1",
    })).rejects.toMatchObject({ name: "CommunicationUnavailableError" });

    expect(statements.map(({ text }) => text === "BEGIN" || text === "COMMIT" || text === "ROLLBACK"
      ? text
      : text.match(/communications_[a-z_]+/)?.[0])).toEqual([
      "BEGIN", "communications_prepare_delivery_command", "communications_record_delivery_failed", "COMMIT",
    ]);
    expect(release).toHaveBeenCalledOnce();
    await port.close();
    expect(end).toHaveBeenCalledOnce();
  });

  it("binds the allowlist checker through a separate role-free transaction", async () => {
    const statements: string[] = [];
    const pool = {
      async connect() {
        return {
          async query(text: string) {
            statements.push(text);
            return text.includes("communications_operator_is_active")
              ? { rows: [{ communications_operator_is_active: true }] }
              : { rows: [] };
          },
          release: vi.fn(),
        };
      },
      end: vi.fn(async () => undefined),
    };
    const port = createPostgresCommunicationsControlPlanePort(
      { connectionString: "postgres://platform" },
      { operatorId: OPERATOR, poolFactory: () => pool as never },
    );

    await expect(port.isOperatorActive(OPERATOR)).resolves.toBe(true);
    expect(statements[0]).toBe("BEGIN");
    expect(statements[1]).toContain("communications_operator_is_active");
    expect(statements[2]).toBe("COMMIT");
  });

  it("refuses incomplete direct construction before opening a pool", () => {
    expect(() => createPostgresCommunicationsControlPlanePort(
      { connectionString: " " }, { operatorId: OPERATOR },
    )).toThrow("communications_database_url_required");
    expect(() => createPostgresCommunicationsControlPlanePort(
      { connectionString: "postgres://platform" }, { operatorId: " " },
    )).toThrow("communications_operator_id_required");
  });
});
