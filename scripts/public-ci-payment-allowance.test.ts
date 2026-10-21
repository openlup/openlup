import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";
import { allowedPaymentAdapterWords, neutralityIncreases } from "./public-ci-neutrality.mjs";

it("keeps the payment vocabulary allowance within exact source/report/ledger paths and carrier tokens", () => {
  const vendor = ["str", "ipe"].join("");
  const words = (path: string, body: string) => allowedPaymentAdapterWords(path, body);
  for (const path of [`packages/platform/src/payments/${vendor}/index.ts`, `packages/platform/test/payments/${vendor}/factory.test.ts`,
    `packages/platform/api/payments-${vendor}.api.md`, "docs/platform/plans/oss-a2-payment-adapters.md"]) {
    expect(words(path, vendor)).toBe(1);
  }
  for (const path of ["packages/platform/package.json", "packages/platform/README.md", "scripts/packages/platform-cold-consumer.ts",
    "packages/platform/changes/a-two.md"]) {
    expect(words(path, `payments/${vendor}`)).toBe(1);
    expect(words(path, vendor)).toBe(0);
    expect(words(path, `payments/${vendor}-other`)).toBe(0);
  }
  for (const path of ["packages/platform/src/payments/index.ts", `packages/core/src/payments/${vendor}/index.ts`,
    `packages/platform/src/payments/${vendor}-other/index.ts`, "packages/platform/changes/nested/a.md"]) {
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
    "packages/platform/README.md", "packages/platform/package.json", "packages/platform/changes/a-two.md"];
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
