import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * The one list of the storefront entry's export names. A later change that adds
 * a name extends this constant; a released name is never removed from it.
 */
const STOREFRONT_EXPORTS = {
  ContinuationId: { kind: "type", experimental: false },
  CommandKey: { kind: "type", experimental: false },
  AttemptNumber: { kind: "type", experimental: false },
  toContinuationId: { kind: "value", experimental: false },
  toCommandKey: { kind: "value", experimental: false },
  toAttemptNumber: { kind: "value", experimental: false },
  getOrCreateContinuationId: { kind: "value", experimental: false },
  readContinuationRecord: { kind: "value", experimental: false },
  advanceAttempt: { kind: "value", experimental: false },
  clearContinuationRecord: { kind: "value", experimental: false },
  ContinuationRecord: { kind: "type", experimental: false },
  ContinuationRecordStorageBinding: { kind: "type", experimental: false },
  SubmitTransportBinding: { kind: "type", experimental: false },
  IdentifierBinding: { kind: "type", experimental: false },
  SubmitFailureClass: { kind: "type", experimental: false },
  SubmitFailureClassifier: { kind: "type", experimental: false },
  PendingAction: { kind: "type", experimental: true },
  PendingActionStorageBinding: { kind: "type", experimental: true },
  StatusTransportBinding: { kind: "type", experimental: true },
  StatusReading: { kind: "type", experimental: true },
  ChangedPayloadPolicy: { kind: "type", experimental: true },
  SubmitOutcomeClass: { kind: "type", experimental: true },
  SubmitOutcomeClassifier: { kind: "type", experimental: true },
  PaymentProviderFacts: { kind: "type", experimental: true },
  ClientEventReporter: { kind: "type", experimental: true },
  StorageFailurePolicy: { kind: "type", experimental: true },
  storefrontAnchor: { kind: "value", experimental: true },
  StorefrontAnchor: { kind: "type", experimental: true },
} as const satisfies Record<string, { kind: "type" | "value"; experimental: boolean }>;

const entryFile = fileURLToPath(new URL("../../src/storefront/index.ts", import.meta.url));
const names = (filter: (name: keyof typeof STOREFRONT_EXPORTS) => boolean) =>
  (Object.keys(STOREFRONT_EXPORTS) as Array<keyof typeof STOREFRONT_EXPORTS>).filter(filter).sort();

function entryExports(): Map<string, ts.Symbol> & { checker: ts.TypeChecker } {
  const program = ts.createProgram([entryFile], {
    strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [],
  });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(entryFile);
  expect(source, "the storefront entry source exists").toBeDefined();
  const module = checker.getSymbolAtLocation(source!);
  expect(module, "the storefront entry is a module").toBeDefined();
  const exports = new Map(checker.getExportsOfModule(module!).map(symbol => [symbol.getName(), symbol]));
  return Object.assign(exports, { checker });
}

it("exports exactly the listed names", () => {
  expect([...entryExports().keys()].sort()).toEqual(names(() => true));
});

it("tags exactly the listed names experimental", () => {
  const exports = entryExports();
  const tagged = [...exports].flatMap(([name, symbol]) => {
    const resolved = symbol.flags & ts.SymbolFlags.Alias ? exports.checker.getAliasedSymbol(symbol) : symbol;
    const declarations = resolved.getDeclarations() ?? [];
    expect(declarations.length, `${name} has a declaration`).toBeGreaterThan(0);
    return declarations.some(declaration => ts.getJSDocTags(declaration).some(tag => tag.tagName.text === "experimental")) ? [name] : [];
  });
  expect(tagged.sort()).toEqual(names(name => STOREFRONT_EXPORTS[name].experimental));
});

it("exposes runtime values only for the listed values", async () => {
  const entry = await import("../../src/storefront/index.js");
  expect(Object.keys(entry).sort()).toEqual(names(name => STOREFRONT_EXPORTS[name].kind === "value"));
});

it("brands without validating", async () => {
  const { toAttemptNumber, toCommandKey, toContinuationId } = await import("../../src/storefront/index.js");
  for (const value of ["", "arbitrary value", " x ", "MiXeD-Case", "not-a-uuid"]) {
    expect(toContinuationId(value)).toBe(value);
    expect(toCommandKey(value)).toBe(value);
  }
  for (const value of [0, -1, 1.5]) expect(toAttemptNumber(value)).toBe(value);
});

it("holds the anchor names as frozen strings", async () => {
  const { storefrontAnchor } = await import("../../src/storefront/index.js");
  const grammar = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/;
  expect(Object.isFrozen(storefrontAnchor)).toBe(true);
  expect(Object.keys(storefrontAnchor)).toEqual(["attribute", "action", "state", "field"]);
  for (const group of Object.values(storefrontAnchor)) {
    expect(Object.isFrozen(group)).toBe(true);
    for (const leaf of Object.values(group)) expect(typeof leaf).toBe("string");
  }
  expect(storefrontAnchor.attribute).toEqual({
    action: "data-openlup-action", state: "data-openlup-state", field: "data-openlup-field", value: "data-openlup-value",
  });
  for (const group of [storefrontAnchor.action, storefrontAnchor.state, storefrontAnchor.field]) {
    for (const [key, leaf] of Object.entries(group)) {
      expect(leaf).toBe(key);
      expect(leaf).toMatch(grammar);
    }
  }
  expect(Object.keys(storefrontAnchor.action)).toEqual(["proceed_to_checkout", "place_order", "continue_payment", "retry_payment", "start_over"]);
  expect(Object.keys(storefrontAnchor.state)).toEqual(["awaiting_payment", "details_changed", "awaiting_authority", "declined", "paid", "paid_pending_activation"]);
  expect(Object.keys(storefrontAnchor.field)).toEqual(["email", "first_name", "last_name", "phone", "address_line1", "address_line2", "city", "postal_code", "terms_accepted"]);
  expect(storefrontAnchor.action.proceed_to_checkout).toBe("proceed_to_checkout");
});
