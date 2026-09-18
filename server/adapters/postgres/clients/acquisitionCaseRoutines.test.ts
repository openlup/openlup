import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";

import { createPostgresAcquisitionCasePort } from "./acquisitionCaseRoutines.js";

const ACTOR = "9f576216-011a-4f67-8404-3f28f7f624d5";
const AT = "2026-08-16T14:00:00.000Z";
const ADDRESS = { source: "fixture", reference: "address-ref-0001", revision: "v1", provenance: "mounted_smoke" };
const PROJECTION = {
  contractVersion: "tester_application_v1",
  caseRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
  contactRef: "acquisition-contact:22222222-2222-4222-8222-222222222222",
  sourceKind: "tester_application",
  consent: {
    consentVersion: "consent.v1",
    policyVersion: "privacy.v1",
    recordedAt: AT,
    locale: "en",
    sourcePath: "/tester-application",
  },
  addressReference: ADDRESS,
  state: "submitted",
  version: 1,
  createdAt: AT,
  updatedAt: AT,
};

function stubPool(responses: unknown[], failOn?: string) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  let releases = 0;
  const end = vi.fn(async () => {});
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
  return { pool, queries, releases: () => releases, end };
}

describe("createPostgresAcquisitionCasePort", () => {
  it("runs submit and exact replay through the capability role", async () => {
    const stub = stubPool([
      { outcome: "created", replayed: false, acquisitionCase: PROJECTION },
      { outcome: "replayed", replayed: true, acquisitionCase: PROJECTION },
    ]);
    const port = createPostgresAcquisitionCasePort(
      { connectionString: "postgres://local" }, { poolFactory: () => stub.pool },
    );
    const command = {
      scope: "public_tester_application" as const,
      sourceKind: "tester_application" as const,
      idempotencyKey: "signup-command-0001",
      requesterKey: "127.0.0.1",
      acceptedAt: AT,
      sourcePath: "/tester-application" as const,
      request: {
        contact: { email: "Tester@Example.COM" },
        consent: { accepted: true as const, consentVersion: "consent.v1", policyVersion: "privacy.v1", locale: "en" as const },
        addressReference: ADDRESS,
      },
    };

    await expect(port.submit(command)).resolves.toEqual({ ok: true, value: PROJECTION, replayed: false });
    await expect(port.submit(command)).resolves.toEqual({ ok: true, value: PROJECTION, replayed: true });
    expect(stub.queries.filter(({ text }) => text === "BEGIN")).toHaveLength(2);
    expect(stub.queries.filter(({ text }) => text === "SET LOCAL ROLE platform_acquisition_runtime")).toHaveLength(2);
    expect(stub.queries.filter(({ text }) => text === "COMMIT")).toHaveLength(2);
    expect(stub.queries.find(({ text }) => text.includes("acquisition_case_submit_v1"))?.values?.[2])
      .toBe("tester@example.com");
    expect(stub.releases()).toBe(2);
    await port.close();
    expect(stub.end).toHaveBeenCalledOnce();
  });

  it("maps bounded list cursors, lifecycle transitions, count and business denials", async () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: AT, id: "11111111-1111-4111-8111-111111111111" })).toString("base64url");
    const next = { createdAt: AT, id: "33333333-3333-4333-8333-333333333333" };
    const active = { ...PROJECTION, state: "active", version: 3 };
    const stub = stubPool([
      { contractVersion: "tester_application_v1", cases: [PROJECTION], nextCursor: next },
      { outcome: "found", acquisitionCase: PROJECTION },
      { outcome: "transitioned", replayed: false, acquisitionCase: active },
      "1",
      { outcome: "contact_conflict" },
    ]);
    const port = createPostgresAcquisitionCasePort(
      { connectionString: "postgres://local" }, { poolFactory: () => stub.pool },
    );

    const listed = await port.list({ actorRef: ACTOR, scope: "public_tester_application", cursor, limit: 1 });
    expect(listed).toMatchObject({ ok: true, value: { cases: [PROJECTION] } });
    if (listed.ok) expect(listed.value.nextCursor).toMatch(/^[A-Za-z0-9_-]+$/);
    await expect(port.get({
      actorRef: ACTOR,
      scope: "public_tester_application",
      caseRef: PROJECTION.caseRef,
    })).resolves.toEqual({ ok: true, value: PROJECTION, replayed: false });
    await expect(port.transition({
      actorRef: ACTOR,
      scope: "public_tester_application",
      idempotencyKey: "transition-command-0001",
      request: { view: "acquisition_case_v1", caseRef: PROJECTION.caseRef, expectedVersion: 2, transition: "activate" },
    })).resolves.toEqual({ ok: true, value: active, replayed: false });
    await expect(port.activeCount("public_tester_application")).resolves.toEqual({ ok: true, value: 1 });
    await expect(port.submit({
      scope: "public_tester_application",
      sourceKind: "tester_application",
      idempotencyKey: "signup-command-0002",
      requesterKey: "127.0.0.2",
      acceptedAt: AT,
      sourcePath: "/tester-application",
      request: {
        contact: { email: "tester@example.com" },
        consent: { accepted: true, consentVersion: "consent.v1", policyVersion: "privacy.v1", locale: "en" },
        addressReference: ADDRESS,
      },
    })).resolves.toEqual({ ok: false, error: { kind: "conflict" } });
  });

  it("returns the immutable original transition projection after a later withdrawal", async () => {
    const approved = { ...PROJECTION, state: "approved", version: 2 };
    const withdrawn = { ...PROJECTION, state: "withdrawn", version: 3, addressReference: null };
    const stub = stubPool([
      { outcome: "transitioned", replayed: false, acquisitionCase: approved },
      { outcome: "transitioned", replayed: false, acquisitionCase: withdrawn },
      { outcome: "replayed", replayed: true, acquisitionCase: approved },
    ]);
    const port = createPostgresAcquisitionCasePort(
      { connectionString: "postgres://local" }, { poolFactory: () => stub.pool },
    );
    const approve = {
      actorRef: ACTOR,
      scope: "public_tester_application" as const,
      idempotencyKey: "approve1",
      request: {
        view: "acquisition_case_v1" as const,
        caseRef: PROJECTION.caseRef,
        expectedVersion: 1,
        transition: "approve" as const,
      },
    };
    await expect(port.transition(approve)).resolves.toEqual({ ok: true, value: approved, replayed: false });
    await expect(port.transition({
      ...approve,
      idempotencyKey: "withdraw1",
      request: { ...approve.request, expectedVersion: 2, transition: "withdraw" },
    })).resolves.toEqual({ ok: true, value: withdrawn, replayed: false });
    await expect(port.transition(approve)).resolves.toEqual({ ok: true, value: approved, replayed: true });
  });

  it("refuses malformed cursors before DB and rolls back unavailable queries", async () => {
    const stub = stubPool([], "acquisition_case_active_count_v1");
    const port = createPostgresAcquisitionCasePort(
      { connectionString: "postgres://local" }, { poolFactory: () => stub.pool },
    );
    await expect(port.list({
      actorRef: ACTOR, scope: "public_tester_application", cursor: "not-json", limit: 25,
    })).resolves.toEqual({ ok: false, error: { kind: "invalid" } });
    expect(stub.queries).toHaveLength(0);

    await expect(port.activeCount("public_tester_application"))
      .resolves.toEqual({ ok: false, error: { kind: "unavailable" } });
    expect(stub.queries.map(({ text }) => text)).toEqual([
      "BEGIN", "SET LOCAL ROLE platform_acquisition_runtime", ACTIVE_COUNT_QUERY, "ROLLBACK",
    ]);
    expect(stub.releases()).toBe(1);
  });

  it("fails closed before pool creation without a database URL", () => {
    const poolFactory = vi.fn();
    expect(() => createPostgresAcquisitionCasePort({ connectionString: " " }, { poolFactory }))
      .toThrow("acquisition_case_database_url_required");
    expect(poolFactory).not.toHaveBeenCalled();
  });
});

const ACTIVE_COUNT_QUERY = "SELECT public.acquisition_case_active_count_v1() AS response";
