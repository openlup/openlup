import type { Pool, PoolClient, QueryResult } from "pg";
import { canonicalCatalogDraftJson } from "@openlup/platform/catalog";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { storeJourneyResources, type JourneyInstallation } from "../helpers/storeJourney.js";
import { awaitReceiptWait, backendPid, idempotencyConflict, markReceiptClientErased, receiptCall, receiptOutcome, receiptTable } from "./destinationReceiptFixture.js";
import { bindDestinationOrder, deferred, destinationFence, insertDestinationOrder, registerDestination, snapshotCommand,
  destinationContext, destinationHash, documentTable, readSnapshot, reachDestinationCutoff,
  selectionTable, snapshot, snapshotPreimage } from "./destinationDocumentFixture.js";

const resources = storeJourneyResources();
let store: JourneyInstallation;
beforeAll(async () => { store = await resources.installation("destination-documents"); }, postgresSetupTimeoutMs);
afterAll(() => resources.close(), postgresTeardownTimeoutMs);

const refusal = (code: string, field: string, fix: string, recheck: string) => ({
  outcome: "refused", code, field, observed: expect.stringMatching(/\S/u), cause: expect.stringMatching(/\S/u), fix, recheck,
});
const stale = (field = "destination.snapshotRef") => refusal("destination_version_changed", field,
  "Re-obtain current evidence. Checkout requires a fresh final quote and acceptance.", "Reselect, re-quote and reaccept before submitting.");
const unavailable = refusal("destination_evidence_unavailable", "destination.snapshotRef",
  "Re-obtain evidence through the authenticated owner.", "Use the authorized checkout or order workflow to obtain evidence.");
const digestMismatch = (field: string, stored = false) => refusal("destination_digest_mismatch", field,
  "Replay the original document and its digest.", stored
    ? "Use authorized review to recover the pair, or start a fresh selection where issuance is available." : "Replay the authentic pair.");
const invalidBinding = refusal("destination_binding_invalid", "destination",
  "Re-obtain authoritative evidence.", "Obtain the original owned tuple.");
const storedBinding = refusal("destination_binding_invalid", "destination",
  "Send the retained evidence to the destination owner for review.",
  "After authorized resolution recheck retained evidence, or start a fresh selection where available.");
const conflict = refusal("destination_idempotency_conflict", "idempotencyKey",
  "Replay the original command or begin a distinct action.", "Use original inputs or a distinct action key.");
const unlinkedOwner = refusal("destination_owner_unlinked", "owner",
  "Establish authorized linkage or use authorized support.", "Sign in to the linked account and restart selection.");
const invalidInput = (field: string) => refusal("address_invalid_input", field, "Correct the indicated input.", "Resubmit valid authored input.");
const invalidKind = refusal("destination_dialect_invalid", "version", "Use the supported entry.", "Invoke the supported checkout or retained-read entry.");
const row = (db: Pool, id: string) => db.query(`SELECT * FROM ${documentTable} WHERE snapshot_ref=$1`, [id]).then(r => r.rows[0]);
const selection = (db: Pool, scope: string) => db.query(`SELECT snapshot_ref, selection_revision FROM ${selectionTable} WHERE scope_ref=$1`, [scope]).then(r => r.rows);
const expire = (pool: Pool, limit: number | null) => pool.query("SELECT public.commerce_destination_v2_expire(clock_timestamp() + interval '30 days',$1) AS count", [limit]).then(r => r.rows[0].count);

it("coordinates exact concurrent snapshot replay before validated policy and preserves the originally issued selection", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), { command } = snapshotCommand(ctx);
  const writer = await runtime.connect(), retry = await runtime.connect();
  const preflight = vi.fn((db: PoolClient, input: typeof command) =>
    receiptCall(db, "read", [{ clientId: ctx.clientId, owner: ctx.owner }, input.dialect, input.requestKey,
      destinationHash(canonicalCatalogDraftJson(snapshotPreimage(ctx, input)))]));
  const submit = async (db: PoolClient, input: typeof command, policy: () => object) => {
    const receipt = await preflight(db, input);
    return snapshot(db, ctx, { ...input, validated: receipt.kind === "absent" ? policy() : undefined });
  };
  const validate = vi.fn(() => command.validated);
  let pending: ReturnType<typeof snapshot> | undefined;
  try {
    await writer.query("BEGIN");
    const first = await submit(writer, command, validate);
    expect(validate).toHaveBeenCalledTimes(1);
    const pid = await backendPid(retry);
    const stalePolicy = vi.fn(() => ({ policyRevision: "replaced" }));
    pending = submit(retry, command, stalePolicy);
    void pending.catch(() => undefined);
    await awaitReceiptWait(owner, pid, "advisory", "ExclusiveLock");
    expect(await preflight.mock.results[1]?.value).toEqual({ kind: "absent" });
    expect(stalePolicy).toHaveBeenCalledTimes(1);
    await writer.query("COMMIT");
    expect(await pending).toEqual({ ...first, replayed: true });
    const newIssue = await snapshot(runtime, ctx);
    expect(newIssue.binding.snapshotRef).not.toBe(first.binding.snapshotRef);
    expect(newIssue.selection.selectionRevision).not.toBe(first.selection.selectionRevision);
    expect(newIssue.binding.destinationDigest).toBe(first.binding.destinationDigest);
    expect(await submit(retry, command, validate)).toEqual({ ...first, replayed: true });
    expect(validate).toHaveBeenCalledTimes(1);
    expect(await preflight.mock.results[2]?.value).toMatchObject({ kind: "receipt", eventId: first.eventId });
    expect(await selection(owner, ctx.scopeRef)).toEqual([{
      snapshot_ref: newIssue.binding.snapshotRef, selection_revision: newIssue.selection.selectionRevision,
    }]);
    const record = await row(owner, first.binding.snapshotRef);
    expect(record.evidence_expires_at.toISOString()).toBe(first.evidenceExpiresAt);
    expect(record.evidence_expires_at.getTime() - record.issued_at.getTime()).toBe(86_400_000);

    const changed = { ...command, original: { ...command.original, address: { ...command.original.address, line1: "A 😀" } } };
    await expect(submit(retry, changed, validate)).rejects.toMatchObject(idempotencyConflict);
    expect(validate).toHaveBeenCalledTimes(1);
    await expect.soft(snapshot(runtime, ctx, changed)).resolves.toEqual(conflict);
    const changedDigest = destinationHash(canonicalCatalogDraftJson(snapshotPreimage(ctx, changed)));
    await expect.soft(snapshot(runtime, ctx, { ...changed, requestDigest: changedDigest })).resolves.toEqual({
      ...conflict, observed: "The receipt records a different original command.",
    });
    for (const validated of [undefined, null, false, ["retired"], { obsolete: true }]) {
      await expect(snapshot(runtime, ctx, { ...command, validated })).resolves.toEqual({ ...first, replayed: true });
    }
    await expect(snapshot(runtime, { ...ctx, scopeRef: randomUUID() }, command)).resolves.toEqual(unlinkedOwner);
    const guest = { ...ctx, owner: { ...ctx.owner, principalKind: "checkout_session" } };
    await expect(snapshot(runtime, guest)).resolves.toEqual(unlinkedOwner);
    const unlinked = { ...ctx, owner: { ...ctx.owner, principalRef: randomUUID() } };
    await expect(snapshot(runtime, unlinked)).resolves.toEqual(unlinkedOwner);
    for (const [input, detail] of [
      [{ scopeRef: undefined }, "scopeRef"], [{ requestKey: false }, "requestKey"], [{ purpose: "other" }, "purpose"],
      [{ extra: true }, "command"], [{ original: { ...command.original, extra: true } }, "original"],
      [{ original: { ...command.original, address: { ...command.original.address, line1: false } } }, "original.address.line1"],
    ] as const) {
      await expect(snapshot(runtime, guest, { ...command, ...input })).resolves.toEqual(invalidInput(detail));
    }
    await expect(snapshot(runtime, guest, { ...command, dialect: "other" }))
      .resolves.toEqual(invalidKind);
    await expect(runtime.query("SELECT public.commerce_snapshot_destination_v2($1,$2,'infinity') AS value", [guest, command]).then(r => r.rows[0].value))
      .resolves.toEqual(invalidInput("now"));
    const invalid = snapshotCommand(ctx).command;
    for (const classificationKeys of [["z", "z"], [true], [null]]) {
      await expect(snapshot(runtime, ctx, { ...invalid, validated: { ...invalid.validated, classificationKeys } }))
        .resolves.toEqual(invalidInput("classificationKeys"));
    }
    expect(await receiptCall(runtime, "read", [{ clientId: ctx.clientId, owner: ctx.owner }, invalid.dialect, invalid.requestKey, invalid.requestDigest]))
      .toEqual({ kind: "absent" });
    expect((await snapshot(runtime, ctx, invalid)).replayed).toBe(false);
  } finally {
    await writer.query("ROLLBACK");
    await pending?.catch(() => undefined);
    writer.release(); retry.release();
  }
});

const issuanceState = async (owner: Pool, ctx: Awaited<ReturnType<typeof destinationContext>>) =>
  (await owner.query(`SELECT
    (SELECT coalesce(jsonb_agg(d ORDER BY snapshot_ref), '[]') FROM ${documentTable} d WHERE client_id=$1) AS documents,
    (SELECT coalesce(jsonb_agg(s), '[]') FROM ${selectionTable} s WHERE scope_ref=$2) AS selections,
    (SELECT coalesce(jsonb_agg(r ORDER BY scoped_key), '[]') FROM ${receiptTable} r WHERE client_id=$1) AS receipts`,
  [ctx.clientId, ctx.scopeRef])).rows[0];

it("refuses an inconsistent digest on a fresh key before effects and preserves exact erased replay", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), { command } = snapshotCommand(ctx);
  await owner.query(`CREATE SEQUENCE public.destination_fixture_writes;
    CREATE FUNCTION public.destination_fixture_count_write() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN PERFORM nextval('public.destination_fixture_writes'); RETURN NEW; END $$;
    CREATE TRIGGER destination_fixture_count_write BEFORE INSERT ON ${documentTable}
      FOR EACH ROW EXECUTE FUNCTION public.destination_fixture_count_write()`);
  try {
    await expect.soft(snapshot(runtime, ctx, { ...command, requestDigest: "0".repeat(64) })).resolves.toEqual({
      ...conflict, observed: "The supplied request digest disagrees with the original command.",
    });
    expect((await owner.query("SELECT is_called FROM public.destination_fixture_writes")).rows).toEqual([{ is_called: false }]);
    expect(await issuanceState(owner, ctx)).toEqual({ documents: [], selections: [], receipts: [] });
    const issued = await snapshot(runtime, ctx, command);
    await runtime.query("SELECT public.commerce_destination_v2_receipts_erase($1)", [ctx.clientId]);
    await runtime.query("SELECT public.commerce_destination_v2_erase($1)", [ctx.clientId]);
    await markReceiptClientErased(owner, ctx.clientId);
    await expect(snapshot(runtime, ctx, { ...command, validated: false })).resolves.toEqual({ evidenceDisposition: "erased" });
    await expect(readSnapshot(runtime, ctx, issued.binding)).resolves.toEqual(unavailable);
    const erased = await issuanceState(owner, ctx);
    await expect(snapshot(runtime, ctx)).resolves.toEqual(refusal("destination_evidence_erased", "owner",
      "Review the privacy disposition.", "Verify the authorized privacy receipt and begin a fresh selection where available."));
    expect(await issuanceState(owner, ctx)).toEqual(erased);
  } finally {
    await owner.query(`DROP TRIGGER destination_fixture_count_write ON ${documentTable};
      DROP FUNCTION public.destination_fixture_count_write(); DROP SEQUENCE public.destination_fixture_writes`);
  }
});

it.each([
  ["existing exact receipt", selectionTable, "AFTER UPDATE", "A receipt already exists for the same scoped key."],
  ["receipt insert collision", receiptTable, "BEFORE INSERT", "The scoped receipt key was occupied during commit."],
])("rolls back the autocommit document, selection and receipt after %s", async (fault, table, timing, observed) => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), { command } = snapshotCommand(ctx);
  const first = await snapshot(runtime, ctx);
  const before = await issuanceState(owner, ctx);
  const args = { ctx: { clientId: ctx.clientId, owner: ctx.owner }, ...command, outcome: await receiptOutcome(owner) };
  await owner.query(`CREATE SEQUENCE public.destination_fixture_conflicts;
    CREATE FUNCTION public.destination_fixture_conflict() RETURNS trigger LANGUAGE plpgsql AS $$
    DECLARE fixture jsonb := TG_ARGV[0]::jsonb;
    BEGIN
      IF pg_trigger_depth() > 1 THEN RETURN NEW; END IF;
      IF TG_TABLE_NAME = 'commerce_destination_v2_checkout_selections' THEN
        IF NEW.snapshot_ref = OLD.snapshot_ref THEN RAISE EXCEPTION 'fixture expected a new document'; END IF;
        PERFORM public.commerce_destination_v2_receipt_commit(fixture->'ctx', fixture->>'dialect',
          fixture->>'requestKey', fixture->>'requestDigest', fixture->'outcome');
      ELSE
        IF NOT EXISTS (SELECT 1 FROM ${selectionTable} s JOIN ${documentTable} d USING (snapshot_ref)
          WHERE s.scope_ref = (fixture->>'scopeRef')::uuid AND to_jsonb(d.snapshot_ref) = NEW.outcome#>'{binding,snapshotRef}') THEN
          RAISE EXCEPTION 'fixture expected both checkout effects';
        END IF;
        INSERT INTO ${receiptTable} SELECT (NEW).*;
      END IF;
      PERFORM nextval('public.destination_fixture_conflicts');
      RETURN NEW;
    END $$`);
  try {
    const { rows: [trigger] } = await owner.query<{ ddl: string }>(`SELECT format(
      'CREATE TRIGGER destination_fixture_conflict ${timing} ON ${table}
        FOR EACH ROW EXECUTE FUNCTION public.destination_fixture_conflict(%L)', $1::text) AS ddl`, [JSON.stringify(args)]);
    await owner.query(trigger!.ddl);
    await expect.soft(snapshot(runtime, ctx, command), fault).resolves.toEqual({ ...conflict, observed });
    expect((await owner.query("SELECT is_called FROM public.destination_fixture_conflicts")).rows).toEqual([{ is_called: true }]);
    expect(await issuanceState(owner, ctx)).toEqual(before);
    if (table === receiptTable) {
      await expect(receiptCall(owner, "commit", [args.ctx, command.dialect, command.requestKey, command.requestDigest],
        { binding: first.binding, selection: first.selection, evidenceExpiresAt: first.evidenceExpiresAt })).rejects.toMatchObject(idempotencyConflict);
      expect(await issuanceState(owner, ctx)).toEqual(before);
    }
    await owner.query(`DROP TRIGGER destination_fixture_conflict ON ${table}`);
    const issued = await snapshot(runtime, ctx, command);
    expect(issued.binding.snapshotRef).not.toBe(first.binding.snapshotRef);
    await expect(snapshot(runtime, ctx, { ...command, validated: null })).resolves.toEqual({ ...issued, replayed: true });
  } finally {
    await owner.query(`DROP TRIGGER IF EXISTS destination_fixture_conflict ON ${table};
      DROP FUNCTION public.destination_fixture_conflict(); DROP SEQUENCE public.destination_fixture_conflicts`);
  }
});

it("propagates a database failure without an already-decided refusal", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner);
  await owner.query(`CREATE FUNCTION public.destination_fixture_database_failure() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE SQLSTATE 'PZ001' USING MESSAGE = 'Fixture database failure'; END $$;
    CREATE TRIGGER destination_fixture_database_failure BEFORE INSERT ON ${documentTable}
      FOR EACH ROW EXECUTE FUNCTION public.destination_fixture_database_failure()`);
  try {
    await expect(snapshot(runtime, ctx)).rejects.toMatchObject({ code: "PZ001", message: "Fixture database failure" });
    expect(await issuanceState(owner, ctx)).toEqual({ documents: [], selections: [], receipts: [] });
  } finally {
    await owner.query(`DROP TRIGGER destination_fixture_database_failure ON ${documentTable};
      DROP FUNCTION public.destination_fixture_database_failure()`);
  }
});

it("rolls back the application-owned transaction before delivering a snapshot refusal", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), { command } = snapshotCommand(ctx);
  const db = await runtime.connect();
  try {
    await db.query("BEGIN ISOLATION LEVEL REPEATABLE READ");
    const result = await snapshot(db, ctx, command);
    expect(result).toHaveProperty("outcome", "refused");
    // The successful SQL statement leaves the application transaction open.
    await expect(db.query("SELECT 1")).resolves.toMatchObject({ rowCount: 1 });
    await db.query("ROLLBACK");
    expect(result).toEqual(refusal("destination_isolation_unsupported", "isolation",
      "Roll back and restart in the required transaction mode.", "Use a read committed writer."));
  } finally {
    await db.query("ROLLBACK");
    db.release();
  }
  expect(await issuanceState(owner, ctx)).toEqual({ documents: [], selections: [], receipts: [] });
});

it("preserves fresh snapshot byte limits, closed fields and text rules", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), { command } = snapshotCommand(ctx);
  const limits = {
    address: { line1: 200, line2: 200, city: 120, postalCode: 32, countryCode: 2, subdivisionCode: 16 },
    contact: { recipientName: 200, contactEmail: 254, contactPhone: 64, companyName: 200, label: 200,
      taxId: 64, deliveryNotes: 500, courierInstructions: 500 },
  };
  const atLimit = (field: string, bytes: number) => field === "countryCode" ? "XA" : field === "subdivisionCode" ? "X".repeat(bytes) : "é".repeat(bytes / 2);
  const valid = { ...command.validated,
    address: Object.fromEntries(Object.entries(limits.address).map(([key, bytes]) => [key, atLimit(key, bytes)])),
    contact: Object.fromEntries(Object.entries(limits.contact).map(([key, bytes]) => [key, atLimit(key, bytes)])),
    policyRef: "é".repeat(360), policyRevision: "é".repeat(360),
    classificationKeys: Array.from({ length: 32 }, (_, index) => `key${String(index).padStart(2, "0")}`.padEnd(64, "a")),
  };
  for (const [section, fields] of Object.entries(limits) as [keyof typeof limits, Record<string, number>][]) {
    for (const [field, bytes] of Object.entries(fields)) {
      await expect(snapshot(runtime, ctx, { ...command,
        validated: { ...valid, [section]: { ...valid[section], [field]: atLimit(field, bytes) + "X" } },
      })).resolves.toEqual(invalidInput(field));
    }
  }
  for (const [validated, field] of [
    [{ policyRef: valid.policyRef + "é" }, "policyRef"], [{ policyRevision: valid.policyRevision + "é" }, "policyRevision"],
    [{ classificationKeys: [...valid.classificationKeys, "z"] }, "classificationKeys"],
    [{ classificationKeys: ["a".repeat(65)] }, "classificationKeys"],
    [{ classificationKeys: ["a", "a"] }, "classificationKeys"],
    [{ classificationKeys: ["b", "a"] }, "classificationKeys"],
    [{ classificationKeys: ["ä"] }, "classificationKeys"],
    [{ contact: { contactEmail: "x\u0007" } }, "contactEmail"],
    [{ address: { ...valid.address, line1: " e" } }, "line1"],
    [{ address: { ...valid.address, line1: "e\u0301" } }, "line1"],
    [{ address: { ...valid.address, "private-key-value": "" } }, "validated.address"],
  ] as const) {
    await expect(snapshot(runtime, ctx, { ...command, validated: { ...valid, ...validated } })).resolves.toEqual(invalidInput(field));
  }
  const original = (padding: string) => ({ ...command.original, address: { ...command.original.address, line1: padding } });
  const { rows: [size] } = await owner.query<{ bytes: number }>("SELECT octet_length($1::jsonb::text) AS bytes", [original("")]);
  const framedSize = 16384 - size!.bytes;
  const large = { ...command, original: original("X".repeat(framedSize)), validated: valid };
  const digest = destinationHash(canonicalCatalogDraftJson(snapshotPreimage(ctx, large)));
  await expect(snapshot(runtime, ctx, { ...large, original: original("X".repeat(framedSize + 1)), requestDigest: digest }))
    .resolves.toEqual(invalidInput("original"));
  await expect(snapshot(runtime, ctx, { ...large, requestDigest: digest })).resolves.toMatchObject({ replayed: false });
});

it("verifies the owned document's stored bytes and exact binding without returning repair values", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), other = await destinationContext(owner);
  const { binding, evidenceExpiresAt } = await snapshot(runtime, ctx);
  const id = binding.snapshotRef;
  const stored = await row(owner, id);
  const verified = await readSnapshot(runtime, ctx, binding);
  expect(verified).toEqual({ binding, document: expect.objectContaining({ ...binding, revision: 1, owner: ctx.owner, clientId: ctx.clientId,
    address: { city: "Zélvórë", line1: "A 😀", line2: "2", postalCode: "00-001", country: "XA", subdivision: "XA-01" } }),
    evidenceExpiresAt, documentDigest: destinationHash(stored.document_text) });
  expect(stored.document_text).toBe(canonicalCatalogDraftJson(["commerce.destination.document.v2", verified.document]));
  expect(binding.destinationDigest).toBe("a2882b0f667052364ed70a0287c97661f94d334da944e62e580a6fbd489646f9");
  for (const [context, ref] of [[other, id], [{ ...ctx, scopeRef: randomUUID() }, id], [ctx, randomUUID()]] as const) {
    await expect(readSnapshot(runtime, context, binding, ref)).resolves.toEqual(unavailable);
  }
  await expect(readSnapshot(runtime, ctx, binding, id, "subscription")).resolves.toEqual(invalidKind);
  await expect(readSnapshot(runtime, ctx, { ...binding, snapshotRef: randomUUID() }, id))
    .resolves.toEqual(invalidBinding);
  await expect(readSnapshot(runtime, ctx, { ...binding, destinationDigest: "0".repeat(64) })).resolves.toEqual(digestMismatch("destinationDigest"));

  const tag = "commerce.destination.document.v2";
  const document = verified.document;
  const bytes = (changes: object) => JSON.stringify([tag, { ...document, ...changes }]);
  const changeBinding = (changes: object) => ({ bytes: bytes(changes), storedBinding: JSON.stringify({ ...binding, ...changes }) });
  const inconsistentOwner = { ...ctx.owner, customerOrSessionRef: other.clientId };
  const { policyRevision: _policyRevision, ...openBinding } = binding;
  const { policyRevision: _storedPolicyRevision, ...openDocument } = document;
  const changedAddress = { address: { ...document.address, line2: "Changed" } };
  const scaledBinding = {
    bytes: stored.document_text.replace('"schemaVersion":2', '"schemaVersion":2.0'),
    storedBinding: JSON.stringify(binding).replace('"schemaVersion":2', '"schemaVersion":2.0'),
  };
  type IntegrityCase = { label: string; bytes: string; hash?: string; storedBinding?: string; ownerScope?: typeof ctx.owner; refusal: typeof invalidBinding };
  const cases: IntegrityCase[] = [
    { label: "stored digest differs", bytes: stored.document_text, hash: "0".repeat(64), refusal: digestMismatch("documentDigest", true) },
    { label: "matching digest with invalid JSON", bytes: "invalid JSON", refusal: digestMismatch("documentDigest", true) },
    { label: "wrong tag", bytes: JSON.stringify(["wrong-tag", document]), refusal: storedBinding },
    { label: "wrong envelope", bytes: JSON.stringify([tag, document, null]), refusal: storedBinding },
    { label: "non-object document", bytes: JSON.stringify([tag, 42]), refusal: storedBinding },
    { label: "decoded owner differs", bytes: bytes({ owner: { ...ctx.owner, installationRef: "other" } }), refusal: storedBinding },
    { label: "decoded client differs", bytes: bytes({ clientId: other.clientId }), refusal: storedBinding },
    { label: "stored owner and client disagree", bytes: bytes({ owner: inconsistentOwner }), ownerScope: inconsistentOwner, refusal: storedBinding },
    { label: "wrong snapshot ref", ...changeBinding({ snapshotRef: randomUUID() }), refusal: storedBinding },
    { label: "wrong schema version", ...changeBinding({ schemaVersion: 1 }), refusal: storedBinding },
    { label: "wrong revision", bytes: bytes({ revision: 2 }), refusal: storedBinding },
    { label: "decoded binding differs", bytes: bytes({ policyRevision: "r2" }), refusal: storedBinding },
    { label: "address digest differs", bytes: bytes(changedAddress), refusal: digestMismatch("destinationDigest", true) },
    { label: "missing policy revision", bytes: JSON.stringify([tag, openDocument]), storedBinding: JSON.stringify(openBinding), refusal: storedBinding },
    { label: "extra binding key", ...changeBinding({ unexpected: "extra" }), refusal: storedBinding },
    { label: "non-string policy revision", ...changeBinding({ policyRevision: 1 }), refusal: storedBinding },
    { label: "blank policy revision", ...changeBinding({ policyRevision: " " }), refusal: storedBinding },
    { label: "policy revision over 720 bytes", ...changeBinding({ policyRevision: "é".repeat(361) }), refusal: storedBinding },
    { label: "noncanonical schema version text", ...scaledBinding, refusal: storedBinding },
    { label: "address digest precedes stored shape", bytes: JSON.stringify([tag, { ...openDocument, ...changedAddress }]),
      storedBinding: JSON.stringify(openBinding), refusal: digestMismatch("destinationDigest", true) },
  ];
  const write = (text: string, hash = destinationHash(text), storedBinding = JSON.stringify(binding), ownerScope = ctx.owner) =>
    owner.query(`UPDATE ${documentTable} SET document_text=$2,document_digest=$3,binding=$4,owner_scope=$5 WHERE snapshot_ref=$1`,
      [id, text, hash, storedBinding, ownerScope]);
  for (const { label, bytes, hash, storedBinding, ownerScope = ctx.owner, refusal } of cases) {
    await write(bytes, hash, storedBinding, ownerScope);
    await expect.soft(readSnapshot(runtime, { ...ctx, owner: ownerScope }, binding), label).resolves.toEqual(refusal);
    const exported = await runtime.query("SELECT public.commerce_destination_v2_export($1) AS data", [ctx.clientId]);
    expect(exported.rows[0].data, label).toEqual([{
      snapshotRef: id, issuedAt: stored.issued_at.toISOString(), evidenceDisposition: "available",
      verification: { status: "failed", code: refusal.code, field: refusal.field },
    }]);
  }
  await write(bytes(changedAddress));
  await expect.soft(readSnapshot(runtime, ctx, { ...binding, policyRevision: "" })).resolves.toEqual(digestMismatch("destinationDigest", true));

  await write(bytes({ address: { constructor: "out-of-domain" } }));
  await expect.soft(readSnapshot(runtime, ctx, { ...binding, policyRevision: "" })).resolves.toEqual(storedBinding);
  const { rows: [invalidExport] } = await runtime.query("SELECT public.commerce_destination_v2_export($1) AS data", [ctx.clientId]);
  expect(invalidExport.data).toEqual([{
    snapshotRef: id, issuedAt: stored.issued_at.toISOString(), evidenceDisposition: "available",
    verification: { status: "failed", code: "destination_binding_invalid", field: "destination" },
  }]);

  // Precedence control: a closed stored binding keeps every pre-existing caller-binding outcome.
  await write(stored.document_text, stored.document_digest);
  await expect(readSnapshot(runtime, ctx, { ...binding, policyRevision: "r2" })).resolves.toEqual(stale("destination.policyRevision"));
  await expect(readSnapshot(runtime, ctx, { ...binding, destinationDigest: "0".repeat(64) })).resolves.toEqual(digestMismatch("destinationDigest"));
  await expect(readSnapshot(runtime, ctx, openBinding as typeof binding)).resolves.toEqual(invalidBinding);
  expect(await readSnapshot(runtime, ctx, binding)).toEqual(verified);
  expect(await row(owner, id)).toEqual(stored);
});

it("enforces DB cutoff before cleanup, bounds expiry, and keeps original issue receipts", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), { command } = snapshotCommand(ctx);
  const old = await snapshot(runtime, ctx, command), latest = await snapshot(runtime, ctx);
  const separate = await destinationContext(owner), other = await snapshot(runtime, separate);
  expect(await expire(owner, 1)).toBe(0);
  await expect(expire(runtime, 1)).rejects.toMatchObject({ code: "42501" });
  for (const limit of [null, 0, -1, 1001]) {
    await expect(expire(owner, limit)).rejects.toMatchObject({ message: "address_invalid_input", detail: "limit" });
  }
  const live = await readSnapshot(runtime, ctx, old.binding);
  await reachDestinationCutoff(owner, old.binding);
  await reachDestinationCutoff(owner, latest.binding);
  await expect(readSnapshot(runtime, ctx, old.binding)).resolves.toEqual(stale());
  const uncleaned = await row(owner, old.binding.snapshotRef);
  expect(uncleaned.document_text).toEqual(expect.any(String));
  const exported = await runtime.query("SELECT public.commerce_destination_v2_export($1) AS value", [ctx.clientId]);
  expect(exported.rows[0].value).toContainEqual({
    snapshotRef: old.binding.snapshotRef, issuedAt: uncleaned.issued_at.toISOString(), evidenceDisposition: "available",
    document: live.document, scopeRef: ctx.scopeRef, documentDigest: live.documentDigest,
    evidenceExpiresAt: uncleaned.evidence_expires_at.toISOString(),
  });
  expect(await expire(owner, 1)).toBe(1);
  expect(await selection(owner, ctx.scopeRef)).toHaveLength(1);
  expect(await expire(owner, 1000)).toBe(1);
  expect(await selection(owner, ctx.scopeRef)).toEqual([]);
  expect((await row(owner, old.binding.snapshotRef))).toMatchObject({
    document_text: null, document_digest: null, evidence_disposition: "expired", binding: old.binding, owner_scope: ctx.owner,
  });
  await expect(readSnapshot(runtime, ctx, old.binding)).resolves.toEqual(stale());
  expect(await snapshot(runtime, ctx, command)).toEqual({ ...old, replayed: true });
  expect(await readSnapshot(runtime, separate, other.binding)).toMatchObject({ binding: other.binding });
  expect(await expire(owner, 1000)).toBe(0);
});

it("refuses a snapshot when its read statement crosses the cutoff before evaluating the binding", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), { binding } = await snapshot(runtime, ctx);
  const { rows: [timing] } = await owner.query(`UPDATE ${documentTable}
    SET evidence_expires_at = clock_timestamp() + interval '2 seconds'
    WHERE snapshot_ref = $1 RETURNING evidence_expires_at`, [binding.snapshotRef]);
  await expect(runtime.query(`WITH gate AS MATERIALIZED (
      SELECT statement_timestamp() < $4::timestamptz AS began_before,
        pg_sleep_until($4::timestamptz + interval '10 milliseconds')
    )
    SELECT public.commerce_read_destination_v2($1, 'snapshot', $2, $3) AS value
    FROM gate WHERE began_before`, [ctx, binding.snapshotRef, binding, timing!.evidence_expires_at]).then(r => r.rows[0]?.value)).resolves.toEqual(stale());
  expect(await row(owner, binding.snapshotRef)).toMatchObject({ evidence_disposition: "available", document_text: expect.any(String) });
});

it("preserves destination runtime grants and denies effective access to decision helpers", async () => {
  const { rows: installedRoles } = await store.owner.query<{ rolname: string }>(
    "SELECT rolname FROM pg_roles WHERE rolname IN ('anon','authenticated','service_role') ORDER BY rolname");
  const roles = installedRoles.map(role => role.rolname);
  const routines = [
    ["commerce_snapshot_destination_v2(jsonb,jsonb,timestamptz)", true, "v"],
    ["commerce_read_destination_v2(jsonb,text,uuid,jsonb)", true, "v"],
    ["commerce_destination_v2_export(uuid)", true, "s"],
    ["commerce_destination_v2_erase(uuid)", true, "v"],
    ["commerce_destination_v2_canonical(jsonb)", false, "s"],
    ["commerce_destination_v2_verified_document(public.commerce_destination_v2_documents)", false, "s"],
    ["commerce_destination_v2_expire(timestamptz,integer)", false, "v"],
    ["commerce_destination_v2_issuance_refusal(text)", false, "i"],
    ["commerce_destination_v2_receipt_legacy(jsonb)", false, "i"],
    ["commerce_destination_v2_receipt_scoped_key_decision(jsonb,text,text,text)", false, "s"],
    ["commerce_destination_v2_receipt_read_decision(jsonb,text,text,text)", false, "s"],
    ["commerce_destination_v2_receipt_lock_decision(jsonb,text,text,text)", false, "v"],
    ["commerce_destination_v2_receipt_commit_decision(jsonb,text,text,text,jsonb)", false, "v"],
  ] as const;
  for (const [name, runtime, volatility] of routines) {
    expect((await store.owner.query(`SELECT prosecdef, provolatile, proconfig,
      NOT EXISTS (SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f',p.proowner))) WHERE grantee=0) AS private,
      ARRAY(SELECT r.rolname::text FROM pg_roles r WHERE r.rolname::text=ANY($2::text[]) AND has_function_privilege(r.oid,p.oid,'EXECUTE')
        ORDER BY r.rolname) AS roles
      FROM pg_proc p WHERE p.oid=$1::regprocedure`, [`public.${name}`, roles])).rows)
      .toEqual([{ prosecdef: runtime, provolatile: volatility, proconfig: ["search_path=pg_catalog, pg_temp"], private: true,
        roles: roles.filter(role => runtime && role === "service_role") }]);
  }
});

it("skips a full page of older bound evidence before applying the expiry limit", async () => {
  const { owner, runtime } = store;
  const bound: string[] = [];
  for (let index = 0; index < 2; index++) {
    const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
    await bindDestinationOrder(owner, ctx, issued);
    bound.push(issued.binding.snapshotRef);
    await owner.query(`UPDATE ${documentTable} SET issued_at='2000-01-01',evidence_expires_at='2000-01-02'
      WHERE snapshot_ref=$1`, [issued.binding.snapshotRef]);
  }
  const ctx = await destinationContext(owner), unbound = await snapshot(runtime, ctx);
  await owner.query(`UPDATE ${documentTable} SET issued_at='2000-01-02',evidence_expires_at='2000-01-03'
    WHERE snapshot_ref=$1`, [unbound.binding.snapshotRef]);
  expect(await expire(owner, bound.length)).toBeGreaterThanOrEqual(1);
  expect(await row(owner, unbound.binding.snapshotRef)).toMatchObject({ evidence_disposition: "expired", document_text: null });
  for (const ref of bound) expect(await row(owner, ref)).toMatchObject({ evidence_disposition: "available", document_text: expect.any(String) });
});

it("rechecks binding absence after expiry waits behind a committed fresh bind", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  await owner.query(`UPDATE ${documentTable} SET evidence_expires_at=clock_timestamp()+interval '2 seconds' WHERE snapshot_ref=$1`,
    [issued.binding.snapshotRef]);
  const bound = deferred<void>(), finish = deferred<void>();
  const writer = destinationFence(owner, ctx, issued, async db => {
    const order = await insertDestinationOrder(db, ctx);
    expect(await registerDestination(db, ctx, order, issued)).toEqual(issued.binding);
    bound.resolve();
    await finish.promise;
  });
  void writer.catch(bound.reject);
  const expiry = await owner.connect();
  let pending: Promise<unknown> | undefined;
  try {
    await bound.promise;
    await expiry.query(`SELECT pg_sleep(greatest(0,extract(epoch FROM evidence_expires_at-clock_timestamp())))
      FROM ${documentTable} WHERE snapshot_ref=$1`, [issued.binding.snapshotRef]);
    const pid = await backendPid(expiry);
    pending = expiry.query("SELECT public.commerce_destination_v2_expire(clock_timestamp(),1000)");
    void pending.catch(() => undefined);
    await awaitReceiptWait(owner, pid, "transactionid", "ShareLock");
    finish.resolve();
    await writer;
    await pending;
    expect(await row(owner, issued.binding.snapshotRef)).toMatchObject({ evidence_disposition: "available", document_text: expect.any(String) });
  } finally {
    finish.resolve();
    await writer.catch(() => undefined);
    await pending?.catch(() => undefined);
    expiry.release();
  }
}, 12000);

it("rechecks the cutoff in a new statement after taking the document lock", async () => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  const ref = issued.binding.snapshotRef;
  await owner.query(`UPDATE ${documentTable} SET issued_at='1999-01-01',evidence_expires_at='1999-01-02'
    WHERE snapshot_ref=$1`, [ref]);
  const clientHolder = await owner.connect(), documentHolder = await owner.connect(), expiry = await owner.connect();
  let pending: Promise<QueryResult<{ count: number }>> | undefined;
  try {
    await clientHolder.query("BEGIN");
    await clientHolder.query("SELECT id FROM public.clients WHERE id=$1 FOR UPDATE", [ctx.clientId]);
    const pid = await backendPid(expiry);
    pending = expiry.query<{ count: number }>("SELECT public.commerce_destination_v2_expire(clock_timestamp(),1) AS count");
    void pending.catch(() => undefined);
    await awaitReceiptWait(owner, pid, "transactionid", "ShareLock");
    const { rows: [deadline] } = await documentHolder.query(`UPDATE ${documentTable}
      SET evidence_expires_at=clock_timestamp()+interval '2 seconds' WHERE snapshot_ref=$1 RETURNING evidence_expires_at`, [ref]);
    await documentHolder.query("BEGIN");
    await documentHolder.query(`SELECT 1 FROM ${documentTable} WHERE snapshot_ref=$1 FOR UPDATE`, [ref]);
    const blocker = await backendPid(documentHolder);
    await clientHolder.query("COMMIT");
    // At the locking statement the new cutoff is in the future. It passes while the row is held.
    await expect.poll(async () => (await owner.query("SELECT $2 = ANY(pg_blocking_pids($1)) AS waiting", [pid, blocker])).rows[0].waiting,
      { timeout: 4000 }).toBe(true);
    await documentHolder.query("SELECT pg_sleep_until($1::timestamptz + interval '10 milliseconds')", [deadline.evidence_expires_at]);
    await documentHolder.query("COMMIT");
    expect((await pending).rows).toEqual([{ count: 1 }]);
    expect(await row(owner, ref)).toMatchObject({ evidence_disposition: "expired", document_text: null });
    expect(await selection(owner, ctx.scopeRef)).toEqual([]);
  } finally {
    await clientHolder.query("ROLLBACK"); await documentHolder.query("ROLLBACK");
    await pending?.catch(() => undefined);
    clientHolder.release(); documentHolder.release(); expiry.release();
  }
}, 12000);

it.each(["REPEATABLE READ", "SERIALIZABLE"])("refuses expiry and erasure under %s", async isolation => {
  const { owner, runtime } = store;
  const ctx = await destinationContext(owner), issued = await snapshot(runtime, ctx);
  const db = await owner.connect(), eraser = await runtime.connect();
  const diagnostic = { code: "22023", message: "destination_isolation_unsupported", detail: "isolation",
    hint: "Roll back and restart in READ COMMITTED." };
  try {
    await db.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await eraser.query(`BEGIN ISOLATION LEVEL ${isolation}`);
    await expect(db.query("SELECT public.commerce_destination_v2_expire(clock_timestamp(),1)"))
      .rejects.toMatchObject(diagnostic);
    await expect(eraser.query("SELECT public.commerce_destination_v2_erase($1)", [ctx.clientId]))
      .rejects.toMatchObject(diagnostic);
  } finally {
    await db.query("ROLLBACK"); await eraser.query("ROLLBACK"); db.release(); eraser.release();
  }
  expect(await readSnapshot(runtime, ctx, issued.binding)).toMatchObject({ binding: issued.binding });
});
