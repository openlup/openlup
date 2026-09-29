import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

// The deprecated re-exports left at the old paths of the modules that moved to
// src/checkout/adapters/stripe and server/runtime/payment. They cross the domain
// import boundary on purpose, and each one is removed in the removal preview
// below.
//
// Two gates enforce the removal. The lockstep package version is 0.<n>.0 for
// openlup-source-preview/<n>, but a commit sets it only before a preview that
// stages packages, so this test fails on the CI of a commit that sets 0.9.0 (or
// a 0.9.0 prerelease) while any re-export remains. The release itself does not
// depend on that bump: the source preview prepare step refuses preview 9 while
// any shim still carries its removal marker line.
//
// The removal PR, in one change: deletes the five shims, and with them their
// removal markers; deletes this test,
// components/deprecatedReExportBindings.test.ts and
// server/domains/payment/paymentAdapterRegistry.test.ts; removes the rows of
// those eight files from config/openlup-publication-catalog.json and re-derives
// the source release contract; removes the sentences that name the shims,
// including the one that begins "Each disables the rule only", from the
// import-boundary paragraphs of docs/platform/ARCHITECTURE_AND_EXTENSIONS.md and
// CONTRIBUTING.md, and restores "and there are no exceptions" to the first;
// removes the deprecated re-export section of src/domains/payment/README.md; and
// replaces the pending upgrade-notes section for these moves in
// .github/VERSIONING_AND_EOL.md with a short note for openlup-source-preview/9:
// the old paths no longer resolve, each is named without an inline-code file
// extension, and the new paths replace them. The removal-marker check in the
// release tooling, and its description in the release procedure, stay.
const REMOVAL_PREVIEW = 9;
const REMOVAL_TAG = `openlup-source-preview/${REMOVAL_PREVIEW}`;
const REMOVAL_MARKER_LINE = `// openlup-remove-before: ${REMOVAL_TAG}`;
const STRIPE = "src/checkout/adapters/stripe";
const CONTRACTS = "src/domains/payment/paymentFormContracts.ts";
const RUNTIME_REGISTRY = "server/runtime/payment/paymentAdapterRegistry.ts";

/** Old path, then every name it re-exports ("type " marks a type-only name) and the path that owns that name now. */
const DEPRECATED_REEXPORTS: Record<string, Record<string, string>> = {
  "server/domains/payment/paymentAdapterRegistry.ts": {
    getPaymentExecutionAdapter: RUNTIME_REGISTRY,
    NoopSettlementNotAllowedError: RUNTIME_REGISTRY,
    UnknownPaymentProviderError: RUNTIME_REGISTRY,
  },
  "src/domains/payment/components/PaymentForm.tsx": {
    PaymentForm: `${STRIPE}/PaymentForm.tsx`,
    "type PaymentFormProps": `${STRIPE}/PaymentForm.tsx`,
    "type PaymentFormCopy": CONTRACTS,
    "type PaymentFormSettlement": CONTRACTS,
  },
  "src/domains/payment/components/RecoveryPaymentSetupForm.tsx": {
    RecoveryPaymentSetupForm: `${STRIPE}/RecoveryPaymentSetupForm.tsx`,
    "type RecoveryPaymentSetupFormProps": `${STRIPE}/RecoveryPaymentSetupForm.tsx`,
    "type RecoveryPaymentSetupFormCopy": CONTRACTS,
  },
  "src/domains/payment/components/StripePaymentStep.tsx": {
    StripePaymentStep: `${STRIPE}/StripePaymentStep.tsx`,
    "type StripePaymentStepProps": `${STRIPE}/StripePaymentStep.tsx`,
  },
  "src/domains/payment/components/useStripePromise.ts": {
    resetStripePromiseCacheForTests: `${STRIPE}/useStripePromise.ts`,
    STRIPE_LOAD_TIMEOUT_MS: `${STRIPE}/useStripePromise.ts`,
    "type StripeLoaderState": `${STRIPE}/useStripePromise.ts`,
    "type StripeLoadStatus": `${STRIPE}/useStripePromise.ts`,
    useStripeLoader: `${STRIPE}/useStripePromise.ts`,
    useStripePromise: `${STRIPE}/useStripePromise.ts`,
  },
};
const OLD_PATHS = Object.keys(DEPRECATED_REEXPORTS).sort();
const repositoryRoot = process.cwd();

function lockstep(): { version: string; preview: number } {
  const { version } = JSON.parse(readFileSync(join(repositoryRoot, "packages/core/package.json"), "utf8")) as { version?: unknown };
  const match = typeof version === "string"
    ? /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.exec(version)
    : null;
  if (typeof version !== "string" || !match) {
    throw new Error(`packages/core/package.json version ${JSON.stringify(version)} is not a semantic version; the lockstep version is 0.<n>.0, or a prerelease of it, for openlup-source-preview/<n>`);
  }
  // A stable major is past every source preview.
  return { version, preview: Number(match[1]) > 0 ? Number.POSITIVE_INFINITY : Number(match[2]) };
}

/** Each name a file re-exports, mapped to the text of the @deprecated JSDoc directly before it, or null. */
function deprecatedReExportTags(file: string, source: string): Record<string, string | null> {
  const sourceFile = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const tags: Record<string, string | null> = {};
  for (const statement of sourceFile.statements) {
    if (!ts.isExportDeclaration(statement) || !statement.moduleSpecifier || !statement.exportClause || !ts.isNamedExports(statement.exportClause)) {
      throw new Error(`${file} may hold only export { ... } from statements`);
    }
    for (const element of statement.exportClause.elements) {
      const tag = ts.getJSDocDeprecatedTag(element);
      const adjacent = tag !== undefined && /^\s*$/u.test(source.slice(tag.parent.end, element.getStart(sourceFile)));
      tags[`${statement.isTypeOnly || element.isTypeOnly ? "type " : ""}${element.name.text}`] = adjacent ? ts.getTextOfJSDocComment(tag.comment) ?? "" : null;
    }
  }
  return tags;
}

describe("deprecated re-exports at moved module paths", () => {
  it.each(OLD_PATHS)("%s is marked for removal, deprecates each name, and goes by the removal preview", (file) => {
    const { version, preview } = lockstep();
    const path = join(repositoryRoot, file);
    if (preview >= REMOVAL_PREVIEW) {
      expect(existsSync(path), `the lockstep version ${version} has reached ${REMOVAL_TAG}; delete ${file} with the other deprecated re-exports`).toBe(false);
      return;
    }
    const source = readFileSync(path, "utf8");
    expect(source.split("\n"), `${file} must carry the line ${REMOVAL_MARKER_LINE}`).toContain(REMOVAL_MARKER_LINE);
    const expected = Object.fromEntries(Object.entries(DEPRECATED_REEXPORTS[file]!).map(([name, owner]) =>
      [name, `Moved to ${owner}; removed in ${REMOVAL_TAG}.`]));
    expect(deprecatedReExportTags(file, source)).toEqual(expected);
  });
});
