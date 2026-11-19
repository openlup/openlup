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


it.each([
  [["--json", "--sku"], "sku", "Supply a value for --sku as shown in preview help."],
  [["--sku", "--json"], "sku", "Supply a value for --sku as shown in preview help."],
  [["--sku", "-1", "--json"], "sku", "Supply a value for --sku as shown in preview help."],
  [["--sku-extra", "--json"], "sku-extra", "Unknown option --sku-extra. See preview help."],
  [["--sku-extra=sample", "--json"], "sku-extra", "Unknown option --sku-extra. See preview help."],
  [["-x", "--json"], "x", "Unknown option -x. See preview help."],
  [["--json=1", "--json"], "json", "Supply a value for --json as shown in preview help."],
] as const)("names the offending preview option for %j", (flags, option, hint) => {
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types", "host/settings.ts", "preview", "inventory_renewal_protection", "{}", ...flags,
  ], { cwd: "examples/neutral-store", encoding: "utf8" });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, refusal: {
    code: "commerce_setting_preview_input_invalid", path: [option], hint,
  } });
});

it.each([
  ["inventory_renewal_protection", "{", [], "json_invalid", ["proposed"]],
  ["inventory_renewal_protection", "{}", ["--configuration", "unknown-store"], "configuration_unknown", ["configuration"]],
  ["inventory_renewal_protection", "{}", ["--as-of", "yesterday"], "input_invalid", ["asOf"]],
  ["inventory_renewal_protection", "{}", ["--database-url", "https://user:private@example.invalid"], "input_invalid", ["database-url"]],
  ["inventory_renewal_protection", "{}", [], "connection_required", []],
  ["checkout_recovery_reminders", "{}", [], "unsupported", ["key"]],
] as const)("reports the preview refusal %s %s %j as %s", (key, value, flags, reason, path) => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "host/settings.ts", "preview", key, value, ...flags, "--json"],
    { cwd: "examples/neutral-store", encoding: "utf8" });
  expect(result.status, result.stderr).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("private@example.invalid");
  const document = JSON.parse(result.stdout);
  expect(document).toMatchObject({ schemaVersion: 1, refusal: {
    code: `commerce_setting_preview_${reason}`, path, rule: expect.any(String),
    remediation: { action: expect.any(String), command: expect.stringContaining("host/settings.ts") },
  } });
  if (reason === "configuration_unknown") {
    expect(document.refusal.hint).toContain("unknown-store");
    expect(document.refusal.hint).toMatch(/supplements.*coffee/u);
  }
});
