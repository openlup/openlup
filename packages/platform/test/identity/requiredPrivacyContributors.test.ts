import { expect, it, vi } from "vitest";
import { createPersonalDataContributorRegistry, createPostgresPrivacyStore, createPrivacyOperations, isNativePrivacyOperations, PrivacyRefusal,
  type PersonalDataContributor, type PrivacyStore } from "../../src/identity/index.js";
import type { PgQueryExecutor } from "../../src/data/index.js";

const id = "11111111-1111-4111-8111-111111111111";
const actor = { principalId: id };
const subject = { kind: "contact" as const, contactId: id };
const input = { subject, idempotencyKey: id };

function contributor(id: string): PersonalDataContributor<null> {
  const version = `${id}.v1`;
  return {
    id, version, ownedResources: [id], prepareErasure: vi.fn(async () => {}),
    export: vi.fn(async () => ({ contributorId: id, version, data: null,
      coverage: { complete: true, included: [], unavailable: [] }, obligations: [] })),
    assessErasure: vi.fn(async () => ({ obligations: [] })),
    eraseOrRetain: vi.fn(async () => ({ contributorId: id, version, obligations: [] })),
  };
}

function composition(owners = [contributor("identity")], expectations: string[] = []) {
  const store = {
    privacyRail: "native" as const,
    readRequiredContributorIds: vi.fn(async (): Promise<readonly string[]> => ["identity"]),
    erasureSupported: true, findReceipt: vi.fn(async () => null),
    resolve: vi.fn(async () => ({ contactId: id, principalId: null, identity: {} })),
    prepareErasure: vi.fn(async () => {}), authorizeErasure: vi.fn(async () => {}),
    eraseIdentity: vi.fn(async () => {}), saveReceipt: vi.fn(async () => {}),
  } satisfies PrivacyStore<null> & { privacyRail: "native"; readRequiredContributorIds(): Promise<readonly string[]> };
  const unitOfWork = { run: vi.fn(<T>(work: (context: null) => Promise<T>) => work(null)) };
  const create = (registered = owners, requiredContributorIds = expectations) => createPrivacyOperations({
    store, unitOfWork, registry: createPersonalDataContributorRegistry(registered, { requiredContributorIds }),
    now: () => new Date(0), randomId: () => id,
  });
  return { store, unitOfWork, operations: create(), owners, create };
}

it("observes an appended required owner on the same operations before touching any subject or contributor", async () => {
  const { store, operations, owners, create } = composition();
  await expect(operations.export(actor, subject)).resolves.toMatchObject({ missingContributors: [] });
  await expect(operations.erase(actor, input)).resolves.toMatchObject({ outcome: "ERASED" });
  vi.clearAllMocks();
  store.readRequiredContributorIds.mockResolvedValue(["destination-documents", "identity"]);
  for (const operation of [() => operations.export(actor, subject), () => operations.erase(actor, input)]) {
    await expect(operation()).rejects.toMatchObject({ code: "PRIVACY_CONTRIBUTOR_MISSING", facts: {
      observed: expect.stringContaining("destination-documents"), cause: expect.any(String), fix: expect.any(String), recheck: expect.any(String),
    } });
  }
  expect(store.readRequiredContributorIds).toHaveBeenCalledTimes(2);
  for (const method of [store.resolve, store.prepareErasure, store.findReceipt, store.saveReceipt, owners[0].export, owners[0].prepareErasure]) {
    expect(method).not.toHaveBeenCalled();
  }
  const repaired = create([...owners, contributor("destination-documents")]);
  await expect(repaired.export(actor, subject)).resolves.toMatchObject({ missingContributors: [] });
  await expect(repaired.erase(actor, input)).resolves.toMatchObject({ outcome: "ERASED" });
});

it.each([
  { raw: null }, { raw: "identity" }, { raw: [] }, { raw: ["identity", "identity"] },
  { raw: ["identity", "Bad"] }, { raw: ["other"] },
  { raw: Array.from({ length: 10_001 }, (_, index) => `fixture-${index}`) },
])("refuses an invalid declaration before side effects", async ({ raw }) => {
  const { store, operations } = composition();
  store.readRequiredContributorIds.mockResolvedValue(raw as readonly string[]);
  await expect(operations.export(actor, subject)).rejects.toMatchObject({ code: "PRIVACY_ASSESSMENT_UNAVAILABLE", facts: expect.any(Object) });
  await expect(operations.erase(actor, input)).rejects.toMatchObject({ code: "PRIVACY_ASSESSMENT_UNAVAILABLE", facts: expect.any(Object) });
  expect(store.resolve).not.toHaveBeenCalled();
  expect(store.prepareErasure).not.toHaveBeenCalled();
});

it("retains the infrastructure cause privately and passes through typed owner refusals", async () => {
  const { store, operations, unitOfWork, owners } = composition();
  const cause = new Error("synthetic driver diagnostic");
  unitOfWork.run.mockRejectedValueOnce(cause);
  const refused = await operations.export(actor, subject).catch(error => error);
  expect(refused).toBeInstanceOf(PrivacyRefusal);
  expect(refused).toMatchObject({ name: "PrivacyRefusal", message: "PRIVACY_ASSESSMENT_UNAVAILABLE",
    code: "PRIVACY_ASSESSMENT_UNAVAILABLE", facts: expect.any(Object) });
  expect(Reflect.ownKeys(refused).filter(key => key !== "stack").sort()).toEqual(["cause", "code", "facts", "message", "name"]);
  expect(Object.getOwnPropertyDescriptor(refused, "cause")).toMatchObject({ value: cause, enumerable: false });
  expect(JSON.stringify(refused)).not.toContain(cause.message);
  const owner = new PrivacyRefusal("PRIVACY_ASSESSMENT_UNAVAILABLE");
  vi.mocked(owners[0].export).mockRejectedValueOnce(owner);
  await expect(operations.export(actor, subject)).rejects.toBe(owner);
  expect(store.readRequiredContributorIds).toHaveBeenCalledTimes(1);
});

it("projects the early host-only erasure veto and allows the two remedies", async () => {
  const { operations, store, unitOfWork, owners, create } = composition([contributor("identity")], ["host-owner"]);
  await expect(operations.erase(actor, input)).rejects.toMatchObject({ code: "PRIVACY_CONTRIBUTOR_MISSING", facts: {
    observed: expect.stringContaining("host-owner"), cause: expect.any(String), fix: expect.any(String), recheck: expect.any(String),
  } });
  expect(unitOfWork.run).not.toHaveBeenCalled();
  expect(store.readRequiredContributorIds).not.toHaveBeenCalled();
  await expect(operations.export(actor, subject)).resolves.toMatchObject({ missingContributors: ["host-owner"] });
  await expect(create(owners, []).erase(actor, input)).resolves.toMatchObject({ outcome: "ERASED" });
  await expect(create([...owners, contributor("host-owner")]).erase(actor, input)).resolves.toMatchObject({ outcome: "ERASED" });
});

it("snapshots the subject before the live read and rejects invalid input before entering a transaction", async () => {
  const { operations, store, unitOfWork } = composition();
  await expect(operations.export(actor, { ...subject, contactId: "invalid" })).rejects.toThrow("privacy_contract_invalid");
  await expect(operations.erase(actor, { ...input, idempotencyKey: "invalid" })).rejects.toThrow("privacy_contract_invalid");
  expect(unitOfWork.run).not.toHaveBeenCalled();
  const callerInput = structuredClone(input);
  store.readRequiredContributorIds.mockImplementationOnce(async () => {
    callerInput.subject.contactId = "22222222-2222-4222-8222-222222222222";
    callerInput.idempotencyKey = callerInput.subject.contactId;
    return ["identity"];
  });
  await expect(operations.erase(actor, callerInput)).resolves.toMatchObject({ outcome: "ERASED" });
  expect(store.resolve).toHaveBeenCalledWith(null, subject, actor);
  expect(store.findReceipt).toHaveBeenCalledWith(null, subject, id);
});

it("only recognizes the native factory result and refuses an omitted reader", () => {
  const { operations, owners, store, unitOfWork } = composition();
  expect(isNativePrivacyOperations(operations)).toBe(true);
  expect(isNativePrivacyOperations({ ...operations })).toBe(false);
  Reflect.deleteProperty(store, "readRequiredContributorIds");
  expect(() => createPrivacyOperations({ store, unitOfWork, now: () => new Date(), randomId: () => id,
    registry: createPersonalDataContributorRegistry(owners, { requiredContributorIds: [] }) })).toThrow("PRIVACY_ASSESSMENT_UNAVAILABLE");
  expect(unitOfWork.run).not.toHaveBeenCalled();
});

it.each([{ rows: [] }, { rows: [{ ids: null }] }, { rows: [{ ids: ["identity"] }, { ids: ["identity"] }] }])(
  "requires exactly one array row from the native reader", async result => {
    const db = { query: vi.fn(async () => result) } as unknown as PgQueryExecutor;
    await expect(createPostgresPrivacyStore().readRequiredContributorIds(db)).rejects.toThrow("privacy_declaration_invalid");
  },
);
