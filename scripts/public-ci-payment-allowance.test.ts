import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { allowedPaymentAdapterWords, neutralityIncreases, scanSnapshots } from "./public-ci-neutrality.mjs";

vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, execFileSync: vi.fn(original.execFileSync) };
});

it("refuses excess market and zone allowances without masking remaining counts", () => {
  const vendor = ["tp", "ay"].join("");
  const path = `packages/platform/src/payments/${vendor}/${vendor}PaymentReconciliationProvider.ts`;
  const zone = ["Europe", "Warsaw"].join("/");
  const declaration = `const REPORTING_TIME_ZONE = "${zone}";`;
  const contents = `${declaration}\n`.repeat(2) + `${String.fromCharCode(80, 76, 78)} `.repeat(2);
  const key = createHash("sha256").update(path).digest("hex");
  // Plant counts below and above the allowance, as a scanner vocabulary change could do.
  for (const measured of [1, 5]) {
    const invoke = vi.mocked(execFileSync);
    invoke.mockReturnValueOnce(JSON.stringify({ counts: [{ path, counts: { "ui-5": measured, "ui-8": measured, "ui-6": 1 } }],
      policy: { rules: [{ id: "tree-brand", terms: [String.fromCharCode(118, 101, 108, 105, 112, 101, 116)] }] } }));
    invoke.mockReturnValueOnce("[]");
    try {
      if (measured === 1) {
        expect(() => scanSnapshots(new Map([[path, Buffer.from(contents)]])))
          .toThrow(`neutrality allowance over-subtracted ui-5 in ${JSON.stringify(path)}: -1`);
        continue;
      }
      const result = scanSnapshots(new Map([[path, Buffer.from(contents)]]));
      const remaining = { "ui-5": 3, "ui-8": 3, "ui-6": 1 };
      expect(result.rows).toEqual({ [key]: remaining });
      expect(neutralityIncreases({}, result.rows)).toHaveLength(Object.keys(remaining).length);
    } finally { invoke.mockClear(); }
  }
});

it.each(["ui-13", "ui-14", "ui-5", "ui-8"])("fails closed when the %s allowance exceeds the scanner count", category => {
  const vendor = category === "ui-13" ? ["str", "ipe"].join("") : ["tp", "ay"].join("");
  const path = `packages/platform/src/payments/${vendor}/${vendor}PaymentReconciliationProvider.ts`;
  const token = category === "ui-8" ? `const REPORTING_TIME_ZONE = "${["Europe", "Warsaw"].join("/")}";`
    : category === "ui-5" ? String.fromCharCode(80, 76, 78) : vendor;
  const contents = `${token}\n`.repeat(2);
  expect(allowedPaymentAdapterWords(path, contents, category)).toBe(2);
  const invoke = vi.mocked(execFileSync);
  invoke.mockReturnValueOnce(JSON.stringify({ counts: [{ path, counts: { [category]: 1 } }],
    policy: { rules: [{ id: "tree-brand", terms: [String.fromCharCode(118, 101, 108, 105, 112, 101, 116)] }] } }));
  invoke.mockReturnValueOnce("[]");
  try {
    expect(() => scanSnapshots(new Map([[path, Buffer.from(contents)]])))
      .toThrow(`neutrality allowance over-subtracted ${category} in ${JSON.stringify(path)}: -1`);
  } finally { invoke.mockClear(); }
});

it("allows the reporting zone only on its exact declaration and path", () => {
  const vendor = ["tp", "ay"].join("");
  const zone = ["Europe", "Warsaw"].join("/");
  const path = `packages/platform/src/payments/${vendor}/${vendor}PaymentReconciliationProvider.ts`;
  const declaration = `const REPORTING_TIME_ZONE = "${zone}";`;
  for (const [candidatePath, contents, allowed] of [[path, declaration, 1],
    [path, ` ${declaration}`, 0], [path, declaration.replace("REPORTING_TIME_ZONE", "OTHER_ZONE"), 0],
    [path, `${declaration} // other`, 0], [path, `${declaration}\nconst OTHER_ZONE = "${zone}";`, 1],
    [`packages/platform/src/payments/${vendor}/other.ts`, declaration, 0],
    [`packages/platform/test/payments/${vendor}/${vendor}PaymentReconciliationProvider.ts`, declaration, 0]] as const) {
    const measured = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "packages/ui/smoke/neutrality.ts", "--counts-json"], {
      input: JSON.stringify([{ path: candidatePath, contents }]), encoding: "utf8",
    })).counts[0].counts["ui-8"];
    expect(allowedPaymentAdapterWords(candidatePath, contents, "ui-8")).toBe(allowed);
    const increases = neutralityIncreases({}, { [candidatePath]: { "ui-8": measured - allowed } });
    expect(increases).toHaveLength(contents === declaration && candidatePath === path ? 0 : 1);
  }
});

it("keeps the payment vocabulary allowance within exact source/report/ledger paths and carrier tokens", () => {
  const vendor = ["str", "ipe"].join("");
  const words = (path: string, body: string) => allowedPaymentAdapterWords(path, body);
  for (const path of [`packages/platform/src/payments/${vendor}/index.ts`, `packages/platform/test/payments/${vendor}/factory.test.ts`,
    `packages/platform/api/payments-${vendor}.api.md`, "docs/platform/plans/oss-a2-payment-adapters.md"]) {
    expect(words(path, vendor)).toBe(1);
  }
  const witnessPath = `packages/platform/test/payments/${["tp", "ay"].join("")}/tpayFailureEvidence.test.ts`;
  const witnessContents = `${vendor} ${vendor.toUpperCase()}`;
  const witnessCount = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "packages/ui/smoke/neutrality.ts", "--counts-json"], {
    input: JSON.stringify([{ path: witnessPath, contents: witnessContents }]), encoding: "utf8",
  })).counts[0].counts["ui-13"];
  expect(witnessCount).toBe(2);
  expect(words(witnessPath, witnessContents)).toBe(2);
  expect(neutralityIncreases({}, { [witnessPath]: { "ui-13": witnessCount - words(witnessPath, witnessContents) } })).toHaveLength(0);
  for (const path of ["packages/platform/package.json", "packages/platform/README.md", "scripts/packages/platform-cold-consumer.ts",
    "packages/platform/changes/a-two.md"]) {
    expect(words(path, `payments/${vendor}`)).toBe(1);
    expect(words(path, vendor)).toBe(0);
    expect(words(path, `payments/${vendor}-other`)).toBe(0);
  }
  for (const path of ["packages/platform/src/payments/index.ts", `packages/core/src/payments/${vendor}/index.ts`,
    `packages/platform/src/payments/${vendor}-other/index.ts`, "packages/platform/changes/nested/a.md",
    ...["src", "test"].map(root => `packages/platform/${root}/payments/${["tp", "ay"].join("")}/index.ts`),
    `packages/platform/test/payments/${["tp", "ay"].join("")}/factory.test.ts`, witnessPath.replace("/test/", "/src/")]) {
    expect(words(path, vendor)).toBe(0);
    const measured = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "packages/ui/smoke/neutrality.ts", "--counts-json"], {
      input: JSON.stringify([{ path, contents: vendor }]), encoding: "utf8",
    }));
    expect(measured.counts[0].counts["ui-13"]).toBe(1);
    const count = measured.counts[0].counts["ui-13"] - words(path, vendor);
    expect(neutralityIncreases({}, { [path]: { "ui-13": count } })).toHaveLength(1);
  }
  const path = `packages/platform/src/payments/${vendor}/index.ts`;
  const contents = vendor + " " + String.fromCharCode(80, 76, 78);
  const measured = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "packages/ui/smoke/neutrality.ts", "--counts-json"], {
    input: JSON.stringify([{ path, contents }]), encoding: "utf8",
  })).counts[0].counts;
  measured["ui-13"] -= words(path, contents);
  delete measured["ui-13"];
  expect(neutralityIncreases({}, { [path]: measured })).toEqual([{ path, category: "ui-5", before: 0, after: 1 }]);
});


it("keeps the second payment adapter and its market token within the approved allowance", () => {
  const vendor = ["tp", "ay"].join("");
  const currency = String.fromCharCode(80, 76, 78);
  const category = "ui-14";
  for (const path of [`packages/platform/src/payments/${vendor}/index.ts`, `packages/platform/test/payments/${vendor}/factory.test.ts`]) {
    expect(allowedPaymentAdapterWords(path, vendor, category)).toBe(1);
    expect(allowedPaymentAdapterWords(path, currency, "ui-5")).toBe(1);
  }
  for (const path of [`packages/platform/api/payments-${vendor}.api.md`, "docs/platform/plans/oss-a2-payment-adapters.md"]) {
    expect(allowedPaymentAdapterWords(path, vendor, category)).toBe(1);
    expect(allowedPaymentAdapterWords(path, currency, "ui-5")).toBe(0);
  }
  const outside = ["packages/platform/src/payments/index.ts", `packages/platform/src/payments/${vendor}-other/index.ts`,
    "packages/platform/README.md", "packages/platform/package.json", "packages/platform/changes/a-two.md",
    ...["src", "test"].map(root => `packages/platform/${root}/payments/${["str", "ipe"].join("")}/index.ts`)];
  for (const path of outside) {
    const contents = vendor + " " + currency;
    const counts = JSON.parse(execFileSync(process.execPath, ["--experimental-strip-types", "packages/ui/smoke/neutrality.ts", "--counts-json"], {
      input: JSON.stringify([{ path, contents }]), encoding: "utf8",
    })).counts[0].counts;
    for (const kind of [category, "ui-5"]) counts[kind] -= allowedPaymentAdapterWords(path, contents, kind);
    expect(neutralityIncreases({}, { [path]: counts })).toEqual(expect.arrayContaining([
      { path, category, before: 0, after: 1 }, { path, category: "ui-5", before: 0, after: 1 },
    ]));
  }
  for (const path of ["packages/platform/package.json", "packages/platform/README.md", "scripts/packages/platform-cold-consumer.ts",
    "packages/platform/changes/a-two.md"]) {
    expect(allowedPaymentAdapterWords(path, `payments/${vendor}`, category)).toBe(1);
    expect(allowedPaymentAdapterWords(path, vendor, category)).toBe(0);
    expect(allowedPaymentAdapterWords(path, `payments/${vendor}-other`, category)).toBe(0);
  }
});
