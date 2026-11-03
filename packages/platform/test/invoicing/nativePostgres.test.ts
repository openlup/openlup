import { createInvoiceAccess } from "../../src/account-support/invoiceAccess.js";
import { describe, expect, it, vi } from "vitest";
import { createCapturedPostgresInvoiceProvider, createPostgresInvoiceAccountHistory } from "../../src/invoicing/postgres/index.js";
import { facts, identity } from "./portFitFixtures.js";

const claimedFacts = { ...facts, sellerRevision: "seller-v1", sellerMode: "frozen" };
function fixture() {
  let observation: unknown;
  let writes = 0;
  const db = { query: vi.fn(async (sql: string, values?: unknown[]) => {
    if (sql.includes("FROM public.invoicing_duties d JOIN")) return { rows: [{ id: "duty-a", document_id: "doc-a", original_key: identity.requestKey,
      parent_duty_id: null, facts, seller_facts: facts.seller, revision_ref: "seller-v1" }] };
    if (sql.startsWith("INSERT")) { if (!observation) { observation = JSON.parse(values![1] as string); writes++; return { rows: [{ event_key: values![0] }] }; } return { rows: [] }; }
    return { rows: observation ? [{ observation }] : [] };
  }) };
  return { db, writes: () => writes };
}

describe("captured native invoice provider", () => {
  it("persists one receipt and non-fiscal PDF, recovers exact identity and refuses conflicting facts", async () => {
    const f = fixture(), { provider, artifacts } = createCapturedPostgresInvoiceProvider(f.db, { enabled: true, providerRef: identity.providerRef });
    expect(await provider.read(identity)).toMatchObject({ kind: "absent", evidence: { exact: true, complete: true, scope: identity } });
    const input = { identity, facts: claimedFacts, recoveryLookupRequired: false };
    const issued = await provider.issue(input);
    expect(issued).toMatchObject({ kind: "issued", identity, replayed: false });
    expect(await provider.issue({ ...input, recoveryLookupRequired: true })).toMatchObject({ kind: "issued", replayed: true });
    expect(await provider.issue({ ...input, facts: { ...claimedFacts, currency: "YYY" } })).toMatchObject({ kind: "refused", code: "identity_mismatch" });
    expect(await provider.read(identity)).toMatchObject({ kind: "found", identity });
    expect(f.writes()).toBe(1);
    if (issued.kind !== "issued") throw new Error("missing receipt");
    const doc = { providerRef: identity.providerRef, documentRef: "doc-a", providerDocumentRef: issued.providerDocumentRef,
      orderRef: identity.orderRef, invoiceRef: identity.invoiceRef, parentProviderDocumentRef: null };
    const artifact = await artifacts.read({ identity: doc, kind: "pdf" });
    expect(artifact.kind).toBe("found");
    if (artifact.kind !== "found") throw new Error("missing artifact");
    const pdf = await artifacts.download({ identity: doc, artifactRef: artifact.artifact.ref });
    expect(pdf.kind).toBe("downloaded");
    if (pdf.kind === "downloaded") expect(Buffer.from(pdf.content).toString()).toContain("NON-FISCAL TEST DOCUMENT");
    expect(await artifacts.download({ identity: doc, artifactRef: "other" })).toMatchObject({ kind: "unknown" });
    expect(await artifacts.read({ identity: { ...doc, providerDocumentRef: "other" }, kind: "pdf" })).toMatchObject({ kind: "unknown" });
    expect(await provider.void({ ...identity, operation: "remote_void" })).toMatchObject({ kind: "unsupported" });
    expect(f.writes()).toBe(1);
  });

  it("recovers a captured receipt after an insertion acknowledgement is lost", async () => {
    const f = fixture();
    let loseAck = true;
    const db = { query: async (sql: string, values?: unknown[]) => {
      const result = await f.db.query(sql, values);
      if (sql.startsWith("INSERT") && loseAck) { loseAck = false; throw Error("synthetic lost acknowledgement"); }
      return result;
    } };
    const input = { identity, facts: claimedFacts, recoveryLookupRequired: false };
    const first = createCapturedPostgresInvoiceProvider(db, { enabled: true, providerRef: identity.providerRef });
    expect(await first.provider.issue(input)).toMatchObject({ kind: "unknown", effectMayHaveSucceeded: true });
    const restarted = createCapturedPostgresInvoiceProvider(f.db, { enabled: true, providerRef: identity.providerRef });
    expect(await restarted.provider.issue({ ...input, recoveryLookupRequired: true })).toMatchObject({ kind: "issued", replayed: true });
    expect(f.writes()).toBe(1);
  });

  it("disabled and foreign provider selections refuse without SQL; failed lookup never proves absence", async () => {
    const query = vi.fn(async () => { throw new Error("synthetic database failure"); });
    const disabled = createCapturedPostgresInvoiceProvider({ query }, { enabled: false, providerRef: identity.providerRef });
    expect(await disabled.provider.issue({ identity, facts, recoveryLookupRequired: false })).toMatchObject({ kind: "unsupported" });
    const selected = createCapturedPostgresInvoiceProvider({ query }, { enabled: true, providerRef: identity.providerRef });
    expect(await selected.provider.read({ ...identity, providerRef: "foreign" })).toMatchObject({ kind: "unsupported" });
    expect(query).not.toHaveBeenCalled();
    expect(await selected.provider.read(identity)).toMatchObject({ kind: "unknown" });
    expect(await selected.provider.issue({ identity, facts, recoveryLookupRequired: true })).toMatchObject({ kind: "unknown", effectMayHaveSucceeded: true });
  });
});

it("denies foreign orders and nonmembers before artifact I/O, preserves empty owned history and reports read failure", async () => {
  const download = vi.fn();
  const db = { query: vi.fn(async (_sql: string, values?: unknown[]) => ({ rows: values?.[0] === "owner" ? [{ documents: [] }] : [] })) };
  const access = createInvoiceAccess({ accountHistory: createPostgresInvoiceAccountHistory(db), artifacts: { download } });
  const augmented = { accountRef: "owner", orderId: "order", privateContext: "synthetic-host-only" };
  expect(await createPostgresInvoiceAccountHistory(db).read(augmented)).toEqual({ kind: "found", accountRef: "owner", orderId: "order", documents: [] });
  expect(await access.history({ accountRef: "owner", orderId: "order" })).toEqual({ kind: "found", accountRef: "owner", orderId: "order", documents: [] });
  expect(await access.history({ accountRef: "foreign", orderId: "order" })).toEqual({ kind: "denied" });
  expect(await access.download({ accountRef: "owner", orderId: "order", documentRef: "foreign-document" })).toEqual({ kind: "denied" });
  expect(await access.download({ accountRef: "foreign", orderId: "order", documentRef: "doc" })).toEqual({ kind: "denied" });
  expect(download).not.toHaveBeenCalled();
  const failed = createPostgresInvoiceAccountHistory({ query: async () => { throw Error("private SQL error"); } });
  expect(await failed.read({ accountRef: "owner", orderId: "order" })).toEqual({ kind: "unknown", code: "unknown" });
});
