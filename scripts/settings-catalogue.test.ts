import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { describeRenewalStockProtectionSetting } from "@openlup/platform/inventory";
import { spawnSync } from "node:child_process";
import { globSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { expect, it } from "vitest";
import { checkSettingsCatalogue, parseSettingData, renderSettingsCatalogue } from "./settings-catalogue.ts";

it("reproduces all three committed settings carriers byte for byte", () => {
  expect(Object.keys(renderSettingsCatalogue())).toHaveLength(3);
  expect(() => checkSettingsCatalogue(process.cwd())).not.toThrow();
});

it("represents every domain data key and executable descriptor in the catalogue", () => {
  const { entries } = JSON.parse(readFileSync("packages/platform/settings-catalog.json", "utf8"));
  const dataKeys = globSync("packages/platform/src/*/settings-data.json").flatMap(path =>
    (JSON.parse(readFileSync(path, "utf8")) as Array<{ key: string }>).map(({ key }) => key));
  const expected = [describeRenewalStockProtectionSetting().key, ...dataKeys].sort();
  expect(entries.map(({ key }) => key)).toEqual(expected);
  expect(new Set(expected).size).toBe(expected.length);
  expect(entries.filter(({ kind }) => kind === "installed").map(({ key }) => key)).toEqual(expect.arrayContaining([
    "inventory_renewal_protection", "checkout_recovery_reminders", "subscriber_winback_policy",
    "pricing.subscriptionPricePolicy", "communications.nativeDeliveryControls",
  ]));
  expect(entries.filter(({ kind }) => kind === "cap").length).toBeGreaterThanOrEqual(40);
  expect(entries.filter(({ kind }) => kind === "code").map(({ key }) => key)).toEqual([
    "catalog.bundleAvailabilityPolicy",
    "checkout.resumeWindowMinutes",
    "communications.terminalPayloadRetentionDays",
    "inventory.offerLowStockThreshold",
    "market.settlementProfile",
  ]);
  expect(entries.find(({ key }) => key === "savedAddressValidation")).toMatchObject({
    kind: "callback", change: { reference: "docs/guide/concepts/starter-ownership.md#saved-addresses-billing-and-preferences" },
  });
  expect(entries.filter(({ kind }) => kind === "invariant").length).toBeGreaterThanOrEqual(7);
});

it("discovers and validates settings data in a new domain directory", () => {
  const root = mkdtempSync(join(tmpdir(), "settings-catalogue-"));
  const file = join(root, "packages/platform/src/fixture-domain/settings-data.json");
  const [sample] = parseSettingData(readFileSync("packages/platform/src/shipping/settings-data.json", "utf8"), "shipping");
  const descriptor = { ...sample, key: "fixture.notice", domain: "fixture-domain" };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([descriptor]));
    const files = renderSettingsCatalogue(root);
    const catalogue = JSON.parse(files["packages/platform/settings-catalog.json"]!);
    expect(catalogue.entries).toContainEqual(expect.objectContaining({ key: descriptor.key, domain: descriptor.domain }));
    expect(files["packages/core/docs/guide/how-to/operate/settings-catalogue.md"]).toContain("## fixture.notice");

    writeFileSync(file, JSON.stringify([{ ...descriptor, unknown: true }]));
    expect(() => renderSettingsCatalogue(root)).toThrow(`Invalid settings data in ${file}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("gives each connected refusal an extracted-app remediation command", () => {
  const { refusals } = JSON.parse(readFileSync("packages/platform/settings-refusals.json", "utf8"));
  const connected = refusals.filter(({ remediation }) => /\brepeat the connected read\b/u.test(remediation.action));
  expect(connected.map(({ code }) => code)).toEqual(expect.arrayContaining([
    "checkout_recovery_policy_invalid", "commerce_setting_read_unavailable",
  ]));
  for (const { code, remediation } of connected) {
    expect(remediation.command, code).toMatch(
      /^npm --silent run settings -- show \S+ --database-url <read-capable-url> --json$/u,
    );
  }
});

it("advertises settings results that the pinned MCP SDK accepts", () => {
  const tools: unknown = JSON.parse(readFileSync("packages/platform/test/operations/settingsReadToolSchemas.main.json", "utf8"));
  expect(ListToolsResultSchema.parse({ tools }).tools.map(tool => tool.name))
    .toEqual(["settings_list", "settings_show", "settings_explain", "settings_check", "settings_preview"]);
});

it("refuses unknown descriptor fields, including nested metadata, and a mismatched domain", () => {
  const contents = readFileSync("packages/platform/src/shipping/settings-data.json", "utf8");
  const [entry] = parseSettingData(contents, "shipping");
  expect(entry).toBeDefined();
  const withEntry = (value: unknown) => JSON.stringify([value]);
  expect(() => parseSettingData(withEntry({ ...entry, extra: true }), "shipping")).toThrow("Unrecognized key");
  if (!entry || !("effect" in entry)) throw new Error("Expected a value descriptor");
  expect(() => parseSettingData(withEntry({ ...entry, effect: { ...entry.effect, extra: true } }), "shipping"))
    .toThrow("Unrecognized key");
  expect(() => parseSettingData(contents, "fulfillment")).toThrow("Descriptor does not belong to fulfillment");
});

it("imports unrelated operations when both settings carriers are unreadable", () => {
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict";
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const readFileSync = fs.readFileSync;
    fs.readFileSync = (path, ...options) => {
      assert.doesNotMatch(String(path), /settings-(?:catalog|refusals)[.]json$/);
      return readFileSync(path, ...options);
    };
    syncBuiltinESMExports();
    const operations = await import("@openlup/platform/operations/server");
    assert.equal(typeof operations.createAdminSettingsReadHandler, "function");
    assert.equal(typeof operations.createPlatformControlPlanePort, "function");
  `], { encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
});

it("uses one reason and no value metadata for caps and invariants", () => {
  const files = renderSettingsCatalogue();
  const { entries } = JSON.parse(files["packages/platform/settings-catalog.json"]!);
  const guide = files["packages/core/docs/guide/how-to/operate/settings-catalogue.md"]!;
  for (const entry of entries.filter(({ kind }) => kind === "cap" || kind === "invariant")) {
    expect(Object.keys(entry).sort()).toEqual(["change", "domain", "goal", "key", "kind", "runtime", "schemaVersion"]);
    const section = guide.split(`## ${entry.key}\n`)[1]!.split("\n## ")[0]!;
    expect(section.split(entry.runtime.reason)).toHaveLength(2);
  }
});

it("keeps the combined stock-wait reason verbatim", () => {
  const files = renderSettingsCatalogue();
  const { entries } = JSON.parse(files["packages/platform/settings-catalog.json"]!);
  const reasons = {
    "subscriptions.stockWaitHoldLifetime": "Native stock-wait recovery fixes the hold at 15 minutes in SQL. The separate reservation port reads holdSeconds from its own reserve call, outside native stock-wait recovery. The starter's scheduled renewal uses this port to expire reservations and leaves its holdSeconds option unused.",
  };
  expect(entries).toEqual(expect.arrayContaining(Object.entries(reasons).map(([key, reason]) =>
    expect.objectContaining({ key, runtime: { level: "read-only", reason } }))));
});

it("points every cap and invariant reference away from settings-catalogue.md", () => {
  const { entries } = JSON.parse(readFileSync("packages/platform/settings-catalog.json", "utf8")) as {
    entries: Array<{ key: string; kind: string; change: { reference: string } }>;
  };
  const nonEditable = entries.filter(({ kind }) => kind === "cap" || kind === "invariant");
  expect(nonEditable.length).toBeGreaterThanOrEqual(47);
  for (const entry of nonEditable) {
    expect(entry.change.reference, entry.key).not.toContain("settings-catalogue.md");
  }
});
