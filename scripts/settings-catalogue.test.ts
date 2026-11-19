import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { settingsReadTools } from "@openlup/platform/operations/server";
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
  ]));
  expect(entries.filter(({ kind }) => kind === "cap").length).toBeGreaterThanOrEqual(43);
  expect(entries.filter(({ kind }) => kind === "invariant").length).toBeGreaterThanOrEqual(7);
});

it("discovers and validates settings data in a new domain directory", () => {
  const root = mkdtempSync(join(tmpdir(), "settings-catalogue-"));
  const file = join(root, "packages/platform/src/fixture-domain/settings-data.json");
  const [sample] = parseSettingData(readFileSync("packages/platform/src/shipping/settings-data.json", "utf8"), "shipping");
  const descriptor = { ...sample, key: "fixture.notice", domain: "fixture-domain", searchTerms: "fixture discovery phrase" };
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify([descriptor]));
    const files = renderSettingsCatalogue(root);
    const catalogue = JSON.parse(files["packages/platform/settings-catalog.json"]!);
    expect(catalogue.entries).toContainEqual(expect.objectContaining({ key: descriptor.key, domain: descriptor.domain }));
    expect(files["packages/core/docs/guide/how-to/operate/settings-catalogue.md"]).toContain("Search terms include fixture discovery phrase.");

    writeFileSync(file, JSON.stringify([{ ...descriptor, unknown: true }]));
    expect(() => renderSettingsCatalogue(root)).toThrow(`Invalid settings data in ${file}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

it("runs each connected refusal remediation through the connected CLI branch", () => {
  const { refusals } = JSON.parse(readFileSync("packages/platform/settings-refusals.json", "utf8"));
  const connected = refusals.filter(({ remediation }) => /\brepeat the connected read\b/u.test(remediation.action));
  expect(connected.map(({ code }) => code)).toEqual(expect.arrayContaining([
    "checkout_recovery_policy_invalid", "commerce_setting_read_unavailable",
  ]));
  for (const { code, remediation } of connected) {
    const [node, ...args] = remediation.command.split(" ");
    expect([node, ...args.slice(0, 3)], code).toEqual(["node", "--experimental-strip-types", "host/settings.ts", "show"]);
    expect(args[args.indexOf("--database-url") + 1], code).toBe("<read-capable-url>");
    // A malformed URL refuses before opening a connection and distinguishes a connected read from offline discovery.
    const result = spawnSync(process.execPath, args.map(arg => {
      if (arg === "<key>") return "checkout_recovery_reminders";
      if (arg === "<read-capable-url>") return "postgresql://[";
      return arg;
    }), { cwd: "examples/neutral-store", encoding: "utf8" });
    expect(result.status, code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ refusal: { code: "commerce_setting_read_unavailable" } });
  }
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

it("advertises settings results that the pinned MCP SDK accepts", () => {
  expect(ListToolsResultSchema.parse({ tools: settingsReadTools }).tools.map(tool => tool.name))
    .toEqual(["settings__list", "settings__show", "settings__preview"]);
});

it("refuses unknown descriptor fields, including nested metadata, and a mismatched domain", () => {
  const contents = readFileSync("packages/platform/src/shipping/settings-data.json", "utf8");
  const [entry] = parseSettingData(contents, "shipping");
  expect(entry).toBeDefined();
  const withEntry = (value: unknown) => JSON.stringify([value]);
  expect(() => parseSettingData(withEntry({ ...entry, extra: true }), "shipping")).toThrow("Unrecognized key");
  expect(() => parseSettingData(withEntry({ ...entry, effect: { ...entry!.effect, extra: true } }), "shipping"))
    .toThrow("Unrecognized key");
  expect(() => parseSettingData(contents, "fulfillment")).toThrow("Descriptor does not belong to fulfillment");
});

it("the offline starter CLI refuses preview and prints the connected command", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "host/settings.ts", "preview",
    "inventory_renewal_protection", '{"revision":"candidate","renewalProtectionDays":21}', "--json"],
  { cwd: "examples/neutral-store", encoding: "utf8" });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    schemaVersion: 1,
    refusal: {
      code: "commerce_setting_preview_connection_required",
      remediation: { command: expect.stringContaining("--database-url <read-capable-url>") },
    },
  });
});
