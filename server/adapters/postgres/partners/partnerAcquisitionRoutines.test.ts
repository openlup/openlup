import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPostgresPartnerAcquisitionPort } from "./partnerAcquisitionRoutines.js";

const ACTOR = "9f576216-011a-4f67-8404-3f28f7f624d5";
const AT = "2026-08-17T10:00:00.000+00:00";
const PROJECTION = {
  contractVersion: "partner_acquisition_v1",
  caseRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
  contactRef: "acquisition-contact:22222222-2222-4222-8222-222222222222",
  organization: { name: "Acme Foods", country: "US" },
  contact: { firstName: "Jane", lastName: "Smith", email: "jane@acme.example", phone: "+15551234567" },
  notes: "Retail inquiry",
  status: "new",
  version: 1,
  createdAt: AT,
  updatedAt: AT,
};

function stubPool(responses: unknown[], failOn?: string) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const end = vi.fn(async () => undefined);
  let releases = 0;
  const pool = {
    async connect() {
      return {
        async query(text: string, values?: unknown[]) {
          queries.push({ text, values });
          if (failOn && text.includes(failOn)) throw Object.assign(new Error("db failed"), { code: "XX000" });
          if (text.startsWith("SELECT public.")) return { rows: [{ response: responses.shift() }] };
          return { rows: [] };
        },
        release() { releases += 1; },
      };
    },
    end,
  } as unknown as Pool;
  return { pool, queries, end, releases: () => releases };
}

function submitCommand() {
  return {
    idempotencyKey: "partner-command-0001",
    requesterKey: "127.0.0.1",
    policyVersion: "partner-inquiry-request-v1",
    sourcePath: "/partners/b2b-inquiries" as const,
    acceptedAt: AT,
    request: {
      company: " Acme   Foods ",
      country: "us",
      firstName: " Jane ",
      lastName: " Smith ",
      email: "Jane@Acme.Example",
      phone: "+1 555 123 4567",
      notes: " Retail   inquiry ",
    },
  };
}

describe("createPostgresPartnerAcquisitionPort", () => {
  it("submits and replays under the acquisition runtime role", async () => {
    const stub = stubPool([
      { outcome: "created", replayed: false, acquisitionCase: PROJECTION },
      { outcome: "replayed", replayed: true, acquisitionCase: PROJECTION },
    ]);
    const port = createPostgresPartnerAcquisitionPort(
      { connectionString: "postgres://local" }, { poolFactory: () => stub.pool },
    );
    await expect(port.submit(submitCommand())).resolves.toEqual({ ok: true, value: PROJECTION, replayed: false });
    await expect(port.submit(submitCommand())).resolves.toEqual({ ok: true, value: PROJECTION, replayed: true });
    const call = stub.queries.find(({ text }) => text.includes("partner_acquisition_submit_v1"));
    expect(call?.values?.slice(2, 9)).toEqual([
      "Acme Foods", "US", "Jane", "Smith", "jane@acme.example", "+15551234567", "Retail inquiry",
    ]);
    expect(stub.queries.filter(({ text }) => text === "SET LOCAL ROLE platform_acquisition_runtime")).toHaveLength(2);
    expect(stub.queries.filter(({ text }) => text === "COMMIT")).toHaveLength(2);
    expect(stub.releases()).toBe(2);
    await port.close();
    expect(stub.end).toHaveBeenCalledOnce();
  });

  it("maps bounded list, transition, conflict and rollback", async () => {
    const contacted = { ...PROJECTION, status: "contacted", version: 2 };
    const next = { createdAt: AT, id: "33333333-3333-4333-8333-333333333333" };
    const stub = stubPool([
      { contractVersion: "partner_acquisition_v1", cases: [PROJECTION], nextCursor: next },
      { outcome: "transitioned", replayed: false, acquisitionCase: contacted },
      { outcome: "version_conflict" },
    ], "never");
    const port = createPostgresPartnerAcquisitionPort(
      { connectionString: "postgres://local" }, { poolFactory: () => stub.pool },
    );
    const listed = await port.list({ view: "partner_acquisition_v1", actorRef: ACTOR, limit: 25 });
    expect(listed).toMatchObject({ ok: true, value: { cases: [PROJECTION] } });
    await expect(port.transition({
      actorRef: ACTOR,
      idempotencyKey: "partner-transition-0001",
      request: { id: PROJECTION.caseRef, expectedVersion: 1, status: "contacted" },
    })).resolves.toEqual({ ok: true, value: contacted, replayed: false });
    await expect(port.transition({
      actorRef: ACTOR,
      idempotencyKey: "partner-transition-0002",
      request: { id: PROJECTION.caseRef, expectedVersion: 1, status: "qualified" },
    })).resolves.toEqual({ ok: false, error: { kind: "conflict" } });
  });

  it("refuses malformed cursors before DB and unavailable queries roll back", async () => {
    const stub = stubPool([], "partner_acquisition_submit_v1");
    const port = createPostgresPartnerAcquisitionPort(
      { connectionString: "postgres://local" }, { poolFactory: () => stub.pool },
    );
    await expect(port.list({
      view: "partner_acquisition_v1", actorRef: ACTOR, cursor: "bad", limit: 25,
    })).resolves.toEqual({ ok: false, error: { kind: "invalid" } });
    expect(stub.queries).toHaveLength(0);
    await expect(port.submit(submitCommand())).resolves.toEqual({ ok: false, error: { kind: "unavailable" } });
    expect(stub.queries.map(({ text }) => text)).toContain("ROLLBACK");
  });

  it("fails before pool creation without a database URL", () => {
    const poolFactory = vi.fn();
    expect(() => createPostgresPartnerAcquisitionPort({ connectionString: " " }, { poolFactory }))
      .toThrow("partner_acquisition_database_url_required");
    expect(poolFactory).not.toHaveBeenCalled();
  });
});
