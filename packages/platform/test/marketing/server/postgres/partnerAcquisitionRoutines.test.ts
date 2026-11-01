import type { Pool } from "pg";
import { describe, expect, it, vi } from "vitest";
import { createPostgresPartnerAcquisitionPort } from "../../../../src/marketing/server/postgres/partnerAcquisitionRoutines.js";

const AT = "2026-01-12T10:00:00.000Z";
const ACTOR = "11111111-1111-4111-8111-111111111119";
const CASE = { contractVersion: "partner_acquisition_v1", caseRef: "acquisition-case:11111111-1111-4111-8111-111111111111",
  contactRef: "acquisition-contact:22222222-2222-4222-8222-222222222222", organization: { name: "North Studio", country: "GB" },
  contact: { firstName: "Ada", lastName: "Vale", email: "ada@studio.example", phone: "+442012345678" }, notes: "sample note",
  status: "new", version: 1, createdAt: AT, updatedAt: AT };
const command = { idempotencyKey: "partner-unit-0001", requesterKey: "requester-unit", policyVersion: "privacy-v1",
  sourcePath: "/partners/b2b-inquiries" as const, acceptedAt: AT, request: { company: "  North \n Studio ", country: " gb ",
    firstName: " Ada ", lastName: " Vale ", email: " Ada@STUDIO.EXAMPLE ", phone: " +44 (20) 1234-5678 ", notes: " sample\n note " } };
function fixture(responses: unknown[] = [], fail?: { text: string; code?: string; rollback?: boolean }) {
  const queries: Array<{ text: string; values?: unknown[] }> = [];
  const release = vi.fn(), end = vi.fn(async () => {});
  const factory = vi.fn(() => ({ connect: async () => ({
    async query(text: string, values?: unknown[]) {
      queries.push({ text, values });
      if (text.includes(fail?.text ?? "never-match") || (fail?.rollback && text === "ROLLBACK"))
        throw Object.assign(new Error("synthetic database refusal"), { code: fail?.code });
      return { rows: text.startsWith("SELECT public.") ? [{ response: responses.shift() }] : [] };
    }, release,
  }), end }) as unknown as Pool);
  return { queries, release, end, factory, port: createPostgresPartnerAcquisitionPort({ connectionString: "postgres://synthetic" }, { poolFactory: factory }) };
}

describe("unchanged partner PostgreSQL adapter", () => {
  it("opens lazily and preserves the twelve normalized submit arguments and transaction effect order", async () => {
    const f = fixture([{ outcome: "created", acquisitionCase: CASE, replayed: false }]);
    expect(f.factory).not.toHaveBeenCalled();
    expect(await f.port.submit(command)).toEqual({ ok: true, value: CASE, replayed: false });
    expect(f.queries.map(({ text }) => text.startsWith("SELECT") ? "SUBMIT" : text))
      .toEqual(["BEGIN", "SET LOCAL ROLE platform_acquisition_runtime", "SUBMIT", "COMMIT"]);
    expect(f.queries[2]!.values).toEqual(["partner-unit-0001", "requester-unit", "North Studio", "GB", "Ada", "Vale",
      "ada@studio.example", "+442012345678", "sample note", "privacy-v1", "/partners/b2b-inquiries", AT]);
    expect(f.release).toHaveBeenCalledOnce();
    await f.port.close(); expect(f.end).toHaveBeenCalledOnce();
  });
  it.each([undefined, null, "", " \t ", "punctuation"])("normalizes optional phone/notes without new validation: %s", async value => {
    const f = fixture([{ outcome: "created", acquisitionCase: CASE }]);
    await f.port.submit({ ...command, request: { ...command.request, phone: value, notes: value } });
    expect(f.queries[2]!.values?.[7]).toBeNull();
    expect(f.queries[2]!.values?.[8]).toBe(value === "punctuation" ? "punctuation" : null);
    await f.port.close();
  });
  it("retains digit normalization including leading-zero SQL refusals", async () => {
    const f = fixture([{ outcome: "invalid" }]);
    expect(await f.port.submit({ ...command, request: { ...command.request, phone: "0123 456 789", country: "OTHER" } }))
      .toEqual({ ok: false, error: { kind: "invalid" } });
    expect(f.queries[2]!.values?.[3]).toBe("OTHER");
    expect(f.queries[2]!.values?.[7]).toBe("+0123456789");
  });
  it("round-trips the cursor tuple and freezes list argument ordering", async () => {
    const tuple = { createdAt: AT, id: CASE.caseRef.split(":")[1] };
    const f = fixture([{ cases: [CASE], nextCursor: tuple }, { cases: [], nextCursor: null }]);
    const first = await f.port.list({ actorRef: ACTOR, view: "partner_acquisition_v1", limit: 2 });
    expect(first).toEqual({ ok: true, value: { contractVersion: "partner_acquisition_v1", cases: [CASE], nextCursor: Buffer.from(JSON.stringify(tuple)).toString("base64url") } });
    if (!first.ok || !first.value.nextCursor) throw new Error("cursor required");
    expect(await f.port.list({ actorRef: ACTOR, view: "partner_acquisition_v1", limit: 3, cursor: first.value.nextCursor }))
      .toEqual({ ok: true, value: { contractVersion: "partner_acquisition_v1", cases: [], nextCursor: null } });
    const calls = f.queries.filter(({ text }) => text.includes("partner_acquisition_operator_list_v1"));
    expect(calls.map(({ values }) => values)).toEqual([[ACTOR, null, null, 2], [ACTOR, AT, tuple.id, 3]]);
    expect(f.factory).toHaveBeenCalledOnce();
  });
  it.each(["invalid-json", Buffer.from("[]").toString("base64url"), Buffer.from('{"createdAt":1,"id":"x"}').toString("base64url")])("refuses malformed cursor before pool work: %s", async cursor => {
      const f = fixture();
      expect(await f.port.list({ actorRef: ACTOR, view: "partner_acquisition_v1", limit: 1, cursor })).toEqual({ ok: false, error: { kind: "invalid" } });
      await f.port.close(); expect(f.factory).not.toHaveBeenCalled(); expect(f.end).not.toHaveBeenCalled();
    });
  it("does not add view, actor, limit or tuple semantics to direct list admission", async () => {
    const cursor = Buffer.from(JSON.stringify({ createdAt: "not-a-time", id: "not-a-uuid" })).toString("base64url");
    const f = fixture([{ cases: [], nextCursor: null }]);
    // Wire/view selection belongs to the host; existing SQL validates the tuple.
    await f.port.list({ actorRef: "not-an-actor", view: "host-selected" as "partner_acquisition_v1", limit: 0, cursor });
    expect(f.queries[2]!.values).toEqual(["not-an-actor", "not-a-time", "not-a-uuid", 0]);
  });
  it("passes transition actor, reference, version, status, key and actual clock in the original order", async () => {
    const f = fixture([{ outcome: "replayed", replayed: true, acquisitionCase: CASE }]);
    const start = Date.now();
    expect(await f.port.transition({ actorRef: ACTOR, idempotencyKey: "transition-unit", request: { id: CASE.caseRef, expectedVersion: 4, status: "closed_won" } }))
      .toEqual({ ok: true, value: CASE, replayed: true });
    const values = f.queries[2]!.values!;
    expect(values.slice(0, 5)).toEqual([ACTOR, CASE.caseRef, 4, "closed_won", "transition-unit"]);
    expect(Date.parse(String(values[5]))).toBeGreaterThanOrEqual(start);
    expect(Date.parse(String(values[5]))).toBeLessThanOrEqual(Date.now());
  });
  it.each([["invalid", "invalid"], ["rate_limited", "rate_limited"], ["not_found", "not_found"],
    ["idempotency_conflict", "conflict"], ["contact_conflict", "conflict"], ["version_conflict", "conflict"],
    ["transition_conflict", "conflict"], ["unknown", "unavailable"]])("preserves %s outcome mapping", async (outcome, kind) => {
    expect(await fixture([{ outcome }]).port.submit(command)).toEqual({ ok: false, error: { kind } });
  });
  it.each([null, [], {}, { outcome: "created", acquisitionCase: { ...CASE, version: 0 } }, { outcome: "created", acquisitionCase: { ...CASE, extra: true } }])("refuses invalid response projections after completing the SQL transaction", async response => {
      const f = fixture([response]);
      expect(await f.port.submit(command)).toEqual({ ok: false, error: { kind: "unavailable" } });
      expect(f.queries.at(-1)!.text).toBe("COMMIT");
    });
  it.each([null, {}, { cases: "invalid" }, { cases: [], nextCursor: {} }])("refuses malformed list response %s", async response => {
    expect(await fixture([response]).port.list({ actorRef: ACTOR, view: "partner_acquisition_v1", limit: 1 }))
      .toEqual({ ok: false, error: { kind: "unavailable" } });
  });
  it.each(["BEGIN", "SET LOCAL ROLE", "SELECT public.", "COMMIT"])("rolls back and releases after %s fails, including rollback failure", async text => {
    const f = fixture([], { text, code: "XX000", rollback: true });
    expect(await f.port.submit(command)).toEqual({ ok: false, error: { kind: "unavailable" } });
    expect(f.queries.at(-1)!.text).toBe("ROLLBACK"); expect(f.release).toHaveBeenCalledOnce();
  });
  it("maps SQLSTATE 22023 alone to invalid and retains missing URL refusal", async () => {
    const f = fixture([], { text: "SELECT public.", code: "22023" });
    expect(await f.port.submit(command)).toEqual({ ok: false, error: { kind: "invalid" } });
    expect(() => createPostgresPartnerAcquisitionPort({ connectionString: " " })).toThrow("partner_acquisition_database_url_required");
  });
});
