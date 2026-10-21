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
