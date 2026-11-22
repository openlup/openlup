import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";
import { z, type ZodType } from "zod";
import { runSettingsCommand, type SettingsAppBindings } from "../../src/operations/server/settingsCommand.js";
import { explainSetting, invalidSettingsCommand, listSettings, previewSetting, refuseSettingsPreview, showSetting } from "../../src/operations/server/settingsRead.js";

import { callSettingsTool, settingsMcpContext, settingsMcpTools } from "../../src/operations/server/settingsMcp.js";
import { renewalStockProtectionPreviewResult } from "../../src/inventory/renewalStockProtection.js";

const key = "inventory_renewal_protection";
const url = "postgresql://sample@read.invalid/shop";
const fourDnsLabels = Array.from({ length: 4 }, () => "a".repeat(63)).join(".");
const databaseOptions = {
  host: "read.invalid", port: 5432, user: "sample", password: expect.any(Function), database: "shop", ssl: false,
};
const asOf = new Date(0).toISOString();
const refusalPrefix = "commerce_setting_preview_";

async function run(
  argv: string[],
  options: { stdin?: string; host?: Parameters<typeof runSettingsCommand>[2] } = {},
) {
  const write = vi.fn<(line: string) => void>();
  const readStdin = vi.fn(async () => options.stdin ?? "");
  const warn = vi.fn<(line: string) => void>();
  const exit = await runSettingsCommand(argv, { write, warn, readStdin }, options.host);
  expect(write).toHaveBeenCalledTimes(1);
  const output = write.mock.calls[0]![0];
  return { exit, output, readStdin, warnings: warn.mock.calls.flat() };
}

const document = (result: object) =>
  JSON.stringify("schemaVersion" in result ? result : { schemaVersion: 1, ...result }) + "\n";

// The package command classifies malformed command lines as usage (64), where
// the starter used exit 1 for all refusals.
it.each([
  ["misplaced flag", ["show", key, "--sku", "A"]],
  ["configuration outside preview", ["list", "--configuration", "coffee"]],
  ["as-of outside preview", ["explain", key, "--as-of", asOf]],
  ["database URL outside a connected command", ["list", "--database-url", url]],
  ["unexpected positional", ["list", "foo"]],
  ["surplus show positional", ["show", key, "extra"]],
  ["surplus explain positional", ["explain", key, "extra"]],
  ["show without key", ["show"]],
  ["explain without key", ["explain"]],
  ["unknown command", ["other", key]],
  ["absent command", []],
] as const)("rejects %s as usage", async (_, argv) => {
  const { exit, output } = await run([...argv, "--json"]);
  expect(exit).toBe(64);
  expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, refusal: { code: "commerce_setting_read_input_invalid", path: [] } });
});

it.each([
  [[], ["--sku"], "sku", "Supply a value for --sku as shown in preview help."],
  [["--app", "./app.ts"], ["--sku", "--json"], "sku", "Supply a value for --sku as shown in preview help."],
  [[], ["--sku-extra=sample"], "sku-extra", "Unknown option --sku-extra. See preview help."],
  [[], ["--bad+name"], "bad+name", "Unknown option --bad+name. See preview help."],
  [[], ["-x"], "x", "Unknown option -x. See preview help."],
  [[], ["--json=1"], "json", "Supply a value for --json as shown in preview help."],
  [[], ["--value", "-1"], "value", "Supply a value for --value as shown in preview help."],
] as const)("names the offending preview option in %j %j", async (prefix, flags, option, hint) => {
  const { exit, output } = await run([...prefix, "preview", key, "--value", "{}", "--json", ...flags]);
  expect(exit).toBe(64);
  expect(output).toBe(document(refuseSettingsPreview(refusalPrefix + "input_invalid", { path: [option], hint })));
});

it.each([
  // Tool-wide usage refusals now identify the offending option as well.
  [["list", "--foo"], "foo", "Unknown option --foo. See settings help."],
  [["list", "--goal"], "goal", "Supply a value for --goal as shown in settings help."],
  [["list", "--help", "--foo"], "foo", "Unknown option --foo. See settings help."],
] as const)("names the offending settings option in %j", async (argv, option, hint) => {
  const { exit, output } = await run(["--json", ...argv]);
  expect(exit).toBe(64);
  const { refusal } = invalidSettingsCommand();
  expect(output).toBe(document({ refusal: { ...refusal, path: [option], hint } }));
});

it("names --goal when used with show", async () => {
  const { exit, output } = await run(["show", key, "--goal", "stock", "--json"]);
  expect(exit).toBe(64);
  expect(JSON.parse(output).refusal).toMatchObject({
    code: "commerce_setting_read_input_invalid", path: ["goal"], hint: "Use --goal with list.",
  });
});

it.each([
  ["omitted URL", undefined, null],
  ["empty URL", "", "Supply a canonical postgres:// or postgresql:// URL"],
  ["database dot segment", `${url}/../west`, "Remove whitespace and dot segments"],
  ["dot segment spelled with escapes", `${url}/%2e%2e/west`, "Remove whitespace and dot segments"],
  ["surrounding whitespace", ` ${url} `, "Remove whitespace and dot segments"],
  ["raw control character", url.replace("sample", "sam\tple"), "Supply a canonical"],
  ["uppercase scheme", url.replace("postgresql:", "POSTGRESQL:"), "Supply a canonical"],
  ["empty serialized password", url.replace("@", ":@"), "write an empty password without the colon"],
  ["IPv6 field with leading zeros", url.replace("read.invalid", "[2001:0db8::1]"), "lowercase hexadecimal without leading zeros for IPv6"],
  ["compressed single IPv6 zero field", url.replace("read.invalid", "[2001:db8::1:2:3:4:5]"), "write a single zero field as 0"],
  ["unclosed IPv6 bracket", url.replace("read.invalid", "[2001:db8::1"), "Use brackets and lowercase hexadecimal"],
  ...["", "not-a-port", "65536"].map(port => [`noncanonical or unparseable port ${port}`, url.replace("/shop", `:${port}/shop`), "port from 1 to 65535"] as const),
  ["zero-padded port", url.replace("/shop", ":05433/shop"), "1 to 65535 without leading zeros"],
  ["postgres scheme", url.replace("postgresql:", "postgres:"), {}],
  ["postgresql scheme", url, {}],
  ["wrong scheme", url.replace("postgresql:", "https:"), "Use the postgres:// or postgresql:// scheme"],
  ["IPv4", url.replace("read.invalid", "192.0.2.1"), { host: "192.0.2.1" }],
  ...["192.0.2.010", "192.0.010.1", "192.0.2", "192.0.2.256", "read.123", "0xc0000201", "0xc0.0.2.0x1", "0x7f.0x", "read.0xface"].map(host =>
    [`ambiguous IPv4 spelling ${host}`, url.replace("read.invalid", host), "Write IPv4 as four decimal octets from 0 to 255 separated by dots, without leading zeros"] as const),
  ["DNS label starting with 0x", url.replace("read.invalid", "read.0xcloud"), { host: "read.0xcloud" }],
  ["63-character DNS label", url.replace("read", "a".repeat(63)), { host: `${"a".repeat(63)}.invalid` }],
  ["64-character DNS label", url.replace("read", "a".repeat(64)), "Keep each DNS label to 63 characters"],
  ["253-character DNS name", url.replace("read.invalid", fourDnsLabels.slice(2)), { host: fourDnsLabels.slice(2) }],
  ["255-character DNS name with four 63-character labels", url.replace("read.invalid", fourDnsLabels), "the name to 253 characters"],
  ["IPv6", url.replace("read.invalid", "[2001:db8::1]"), { host: "2001:db8::1" }],
  ["missing host", url.replace("sample@read.invalid", ""), "postgresql://user@host/database"],
  ["socket hostname", url.replace("read.invalid", "%2Ffake%2Fsocket"), "Replace an escaped, socket or comma-separated host"],
  ["escaped hostname", url.replace("read", "%72ead"), "Replace an escaped, socket or comma-separated host"],
  ["comma-separated hosts", url.replace("read.invalid", "read.invalid,backup.invalid"), "Replace an escaped, socket or comma-separated host"],
  ["non-DNS host", url.replace("read.invalid", "bad..invalid"), "Use one lowercase DNS name"],
  ["DNS label ending in a hyphen", "postgresql://sample@read-.invalid/shop", "Each label must begin and end with a letter or digit"],
  ["uppercase host", "postgresql://sample@Read.invalid/shop", "Use one lowercase DNS name"],
  ...[1, 5432, 65535].map(port => [`explicit port ${port}`, url.replace("/shop", `:${port}/shop`), { port }] as const),
  ["port zero", url.replace("/shop", ":0/shop"), "port from 1 to 65535"],
  ["missing user", url.replace("sample@", ""), "Name the PostgreSQL username"],
  ["empty user", url.replace("sample@", ":fake@"), "Name the PostgreSQL username"],
  ["missing database path", url.replace("/shop", ""), "one non-empty database path segment"],
  ["empty database path", url.replace("shop", ""), "one non-empty database path segment"],
  ["multiple database path segments", `${url}/west`, "one non-empty database path segment"],
  ["escaped credentials and database", "postgresql://some%40user:fake%25%252F@read.invalid/shop%2Fwest",
    { user: "some@user", password: "fake%%2F", database: "shop/west" }],
  ["bad username escape", url.replace("sample", "sample%"), "valid UTF-8 URL components"],
  ["bad password escape", url.replace("@", ":sample%Q1@"), "valid UTF-8 URL components"],
  ["bad database UTF-8", `${url}%FF`, "valid UTF-8 URL components"],
  ["escaped control character", url.replace("@", ":fake%00@"), "without control characters"],
  ["63-byte username and database", url.replace("sample", encodeURIComponent("é".repeat(31) + "x")).replace("shop", "x".repeat(63)),
    { user: "é".repeat(31) + "x", database: "x".repeat(63) }],
  ["64-byte database", url.replace("shop", "x".repeat(64)), "at most 63 bytes each in UTF-8"],
  ["64-byte multibyte username", url.replace("sample", encodeURIComponent("é".repeat(32))), "at most 63 bytes each in UTF-8"],
  ["64-byte multibyte database", url.replace("shop", encodeURIComponent("é".repeat(32))), "at most 63 bytes each in UTF-8"],
  ["fragment", `${url}#section`, "Remove the fragment"],
  ["empty fragment", `${url}#`, "Remove the fragment"],
  ["disabled TLS", `${url}?sslmode=disable`, {}],
  ...["require", "verify-full"].map(mode => [`TLS ${mode}`, `${url}?sslmode=${mode}`,
    { ssl: { rejectUnauthorized: true, host: "read.invalid" } }] as const),
  ["IPv6 TLS peer", `${url.replace("read.invalid", "[2001:db8::1]")}?sslmode=verify-full`,
    { host: "2001:db8::1", ssl: { rejectUnauthorized: true, host: "2001:db8::1" } }],
  ["unlisted TLS mode", `${url}?sslmode=prefer`, "a single sslmode"],
  ["empty TLS mode", `${url}?sslmode=`, "a single sslmode"],
  ["bad query escape", `${url}?sslmode=disable%`, "a single sslmode"],
  ["invalid query UTF-8", `${url}?sslmode=%FF`, "works with verified TLS under Node's trust store"],
  ["escaped query name", `${url}?%73slmode=disable`, "a single sslmode"],
  ["repeated TLS mode", `${url}?sslmode=disable&sslmode=require`, "a single sslmode"],
  ["repeated TLS mode by encoded name", `${url}?sslmode=disable&%73slmode=require`, "a single sslmode"],
  ...["host", "hostaddr", "port", "dbname", "user", "password", "options", "service", "socket", "sslrootcert", "other"]
    .map(name => [`disallowed ${name} option`, `${url}?${name}=fake`, "works with verified TLS under Node's trust store"] as const),
  ["bare query", `${url}?`, "a single sslmode"],
  ["empty query field", `${url}?sslmode=disable&`, "?sslmode=disable, ?sslmode=require or ?sslmode=verify-full"],
] as const)("admits settings database URLs: %s", async (_, databaseUrl, expected) => {
  for (const command of [["show", key], ["preview", key, "--value", "{}"]]) {
    const isPreview = command[0] === "preview";
    const bind = vi.fn(async (_input: Parameters<NonNullable<Parameters<typeof runSettingsCommand>[2]>["bind"]>[0]) => ({
      readers: { [key]: async () => ({ present: false as const }) },
      previewers: { [key]: async () => ({ schemaVersion: 1 as const }) },
    }));
    const flags = databaseUrl === undefined ? [] : [`--database-url=${databaseUrl}`];
    const { exit, output, warnings } = await run([...command, ...flags, "--json"], { host: { bind } });
    if (typeof expected === "string") {
      expect(exit).toBe(64);
      expect(JSON.parse(output).refusal).toMatchObject({ path: ["database-url"], hint: expect.stringContaining(expected),
        code: isPreview ? refusalPrefix + "input_invalid" : "commerce_setting_read_input_invalid" });
      const text = await run([...command, ...flags], { host: { bind } });
      expect(text.exit).toBe(64);
      expect(text.output).toContain(expected);
      expect(output + text.output + text.warnings.join("\n")).not.toMatch(/read\.invalid|backup\.invalid|sample|fake/iu);
      expect([...warnings, ...text.warnings]).toEqual([]);
      expect(bind).not.toHaveBeenCalled();
    } else if (expected === null) {
      expect(exit).toBe(isPreview ? 1 : 0);
      if (isPreview) expect(JSON.parse(output).refusal.code).toBe(refusalPrefix + "connection_required");
      expect(bind).not.toHaveBeenCalled();
    } else {
      expect(exit).toBe(0);
      expect(bind).toHaveBeenCalledExactlyOnceWith({ database: { ...databaseOptions, ...expected }, app: undefined, configuration: undefined });
      const password = bind.mock.calls[0]![0].database?.password;
      if (typeof password === "function") expect(password()).toBe("");
    }
  }
});

it.each([
  [["-"], "{}", {}, 1],
  [["=-1"], undefined, -1, 0],
  [["", "null"], undefined, null, 0],
] as const)("decodes --value %j exactly once", async ([arg, following], stdin, expected, reads) => {
  const skus = ["SKU-1", "SKU-2", "SKU-1"];
  const proposed = { schemaVersion: 1 as const, validation: { state: "invalid" } };
  const preview = vi.fn(async () => proposed);
  const close = vi.fn(async () => {});
  const bindings = { previewers: { [key]: preview }, close };
  const bind = vi.fn(async () => bindings);
  const args = arg.startsWith("=") ? ["--value" + arg] : ["--value", arg || following!];
  const { exit, output, readStdin } = await run(["preview", key, ...args, "--database-url", url, "--app", "./app.mjs",
    "--configuration", "sample", "--as-of", asOf, ...skus.flatMap(sku => ["--sku", sku]), "--json"], { host: { bind }, stdin });
  expect(exit).toBe(0);
  expect(output).toBe(document(await previewSetting({ key, proposed: expected, skus, asOf }, bindings.previewers)));
  expect(bind).toHaveBeenCalledExactlyOnceWith({ database: databaseOptions, app: "./app.mjs", configuration: "sample" });
  expect(preview).toHaveBeenNthCalledWith(1, expected, { skus: skus.slice(0, 2), asOf, refuse: refuseSettingsPreview });
  expect(close).toHaveBeenCalledTimes(1);
  expect(readStdin).toHaveBeenCalledTimes(reads);
});

it.each([
  // --value now names the proposal; invalid syntax/input exits 64.
  ["missing proposal", key, [], "input_invalid", ["proposed"], 64],
  ["positional proposal", key, ["{}"], "input_invalid", ["proposed"], 64],
  ["surplus positional proposal", key, ["--value", "{}", "{}"], "input_invalid", ["proposed"], 64],
  ["repeated proposal with malformed first value", key, ["--value", "{", "--value={}", "--database-url", url], "input_invalid", ["value"], 64],
  ["repeated proposal with valid values", key, ["--value", "{}", "--value", "{}", "--database-url", url], "input_invalid", ["value"], 64],
  ["repeated proposal with stdin first", key, ["--value", "-", "--value", "{}", "--database-url", url], "input_invalid", ["value"], 64],
  ["malformed proposal", key, ["--value", "{"], "json_invalid", ["proposed"], 64],
  ["empty proposal", key, ["--value="], "json_invalid", ["proposed"], 64],
  ["malformed proposal before URL", key, ["--value", "{", "--database-url", "postgresql://"], "json_invalid", ["proposed"], 64],
  ["bad instant", key, ["--value", "{}", "--as-of", "yesterday"], "input_invalid", ["asOf"], 64],
  ["empty SKU", key, ["--value", "{}", "--sku", ""], "input_invalid", ["skus"], 64],
  ["nonfinite proposal", key, ["--value", "1e999"], "input_invalid", ["proposed"], 64],
  ["nonfinite proposal under an own key", key, ["--value", '{"outer":{"__proto__":1e400}}'], "input_invalid", ["proposed"], 64],
  ["unknown key", "unknown", ["--value", "{}"], "unknown", ["key"], 1],
  ["unsupported key", "checkout_recovery_reminders", ["--value", "{}"], "preview_unsupported", ["key"], 1],
  ["missing database URL", key, ["--value", "{}"], "connection_required", [], 1],
] as const)("reports preview refusal for %s", async (_, setting, argv, code, path, status) => {
  const bind = vi.fn();
  const { exit, output, readStdin } = await run(["preview", setting, ...argv, "--json"], { host: { bind } });
  expect(exit).toBe(status);
  expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, refusal: { code:
    code === "unknown" || code === "preview_unsupported" ? "commerce_setting_" + code : refusalPrefix + code, path } });
  expect(bind).not.toHaveBeenCalled();
  expect(readStdin).not.toHaveBeenCalled();
});

it("uses the same dispatcher bytes for offline results and refusals", async () => {
  const reminder = "checkout_recovery_reminders";
  const cases = [
    [["list", "--goal", "renewal stock"], listSettings({ goal: "renewal stock" }), 0],
    [["list", "--goal", " "], listSettings({ goal: " " }), 64],
    [["show", reminder], await showSetting({ key: reminder }), 0],
    [["show", "unknown"], await showSetting({ key: "unknown" }), 1],
    [["explain", "commerce_setting_unknown"], explainSetting("commerce_setting_unknown"), 0],
    [["explain", reminder], explainSetting(reminder), 0],
    [["explain", "unknown"], explainSetting("unknown"), 1],
    [["preview", reminder, "--value", "{}"], await previewSetting({ key: reminder, proposed: {} }), 1],
    [["preview", key, "--value", "{}"], await previewSetting({ key, proposed: {} }), 1],
  ] as const;
  const bind = vi.fn();
  for (const [argv, represented, expectedExit] of cases) {
    const { exit, output } = await run([...argv, "--json"], { host: { bind } });
    expect(exit).toBe(expectedExit);
    expect(output).toBe(document(represented));
  }
  expect(bind).not.toHaveBeenCalled();
});

it.each([
  ["text", [], "No settings matched the goal.\nTry fewer or different words, or run list without --goal.\n"],
  ["json", ["--json"], '{"schemaVersion":1,"entries":[]}\n'],
] as const)("renders an empty list in %s", async (_, flags, expected) => {
  const { exit, output } = await run(["list", "--goal", "qzxunique", ...flags]);
  expect(exit).toBe(0);
  expect(output).toBe(expected);
});

it("signals partialMatch only on partial goal matches in list text and JSON", async () => {
  const partialJson = await run(["list", "--goal", "renewal qzxunique", "--json"]);
  expect(partialJson.exit).toBe(0);
  expect(JSON.parse(partialJson.output)).toMatchObject({ schemaVersion: 1, partialMatch: true });
  const partialText = await run(["list", "--goal", "renewal qzxunique"]);
  expect(partialText.exit).toBe(0);
  expect(partialText.output.startsWith("Partial matches (not all goal words matched):\n")).toBe(true);

  const exactJson = await run(["list", "--goal", "renewal", "--json"]);
  expect(exactJson.exit).toBe(0);
  expect(JSON.parse(exactJson.output)).not.toHaveProperty("partialMatch");
  const exactText = await run(["list", "--goal", "renewal"]);
  expect(exactText.exit).toBe(0);
  expect(exactText.output).not.toContain("Partial matches");
});

it.each([
  ["list result", ["list", "--goal", "inventory buffer"], "inventory_renewal_protection (installed, preview)"],
  ["compact list reason", ["list", "--goal", "shipping.addressRegions"],
    "\n  The native address contract requires a postal code and has no region field.\n  Change: docs/guide/"],
  ["text refusal", ["show", "unknown"], "commerce_setting_unknown"],
  ["text explanation", ["explain", "commerce_setting_unknown"], "commerce_setting_unknown"],
  ["text provenance", ["show", key], "Basis: reference-code (matches the reference deployment’s code)"],
  ["text neutral basis", ["show", "savedAddressValidation"], "Basis: neutral\n"],
  ["text absent behavior", ["explain", "checkout_recovery_reminders"], "Unpinned checkout recovery episodes"],
] as const)("renders %s through the package command", async (name, argv, expected) => {
  const { exit, output } = await run([...argv]);
  expect(exit).toBe(name === "text refusal" ? 1 : 0);
  expect(output).toContain(expected);
});

it.each([
  [key, undefined, true, 0, undefined],
  ["unknown", "./app.ts", false, 1, undefined],
  ["subscriber_winback_policy", undefined, false, 1, "Pass --app <module> that supplies a reader for this setting."],
  ["subscriber_winback_policy", "./app.ts", false, 1, "No connected reader exists for this key. Omit --database-url for offline discovery."],
  ["savedAddressValidation", undefined, false, 0, undefined],
] as const)("shows %s with database URL and app %s", async (setting, app, hasReader, expectedExit, hint) => {
  const readers = hasReader ? { [setting]: async () => ({ present: false as const }) } : {};
  const bind = vi.fn(async () => ({ readers }));
  const { exit, output } = await run(["show", setting, "--database-url", url, "--json", ...(app ? ["--app", app] : [])], { host: { bind } });
  expect(exit).toBe(expectedExit);
  if (hint) {
    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({
      refusal: { code: "commerce_setting_read_unavailable", path: ["key"], hint },
    });
    expect(parsed.refusal.rule).not.toContain("SELECT");
    expect(parsed.refusal.remediation.action).not.toContain("SELECT");
    expect(parsed.refusal.remediation.retry).toBe(app === undefined);
    expect(parsed.refusal.remediation.command).toBe("npm --silent run settings -- show <key> --json");
  }
  else expect(output).toBe(document(await showSetting({ key: setting }, readers)));
  // A connected request only needs a binding for a known installed key.
  expect(bind).toHaveBeenCalledTimes(setting === "savedAddressValidation" || setting === "unknown" ? 0 : 1);
});

it("shows a recorded policy override and closes the connected reader", async () => {
  const value = { revision: "installed", renewalProtectionDays: 14 };
  const read = vi.fn(async () => ({ present: true as const, value, revision: value.revision }));
  const close = vi.fn(async () => {});
  const { exit, output } = await run(["show", key, "--database-url", url, "--json"], {
    host: { bind: async () => ({ readers: { [key]: read }, close }) },
  });
  expect(exit).toBe(0);
  expect(JSON.parse(output)).toMatchObject({ observation: { state: "override", value, revision: value.revision } });
  expect(read).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("names --app when connected preview lacks a stock binding", async () => {
  const host = { bind: vi.fn(async () => ({})) };
  const { exit, output } = await run(["preview", key, "--value", "{}", "--database-url", url, "--json"], { host });
  expect(exit).toBe(1);
  expect(JSON.parse(output).refusal).toMatchObject({
    code: refusalPrefix + "connection_required", path: ["app"], hint: expect.stringContaining("--app"),
  });
});

const canonicalUrlHint = "Supply a canonical postgres:// or postgresql:// URL with a host, username and database. Use brackets and lowercase hexadecimal without leading zeros for IPv6, compress the first longest run of two or more zero fields to ::, and write a single zero field as 0. Omit the port or use a port from 1 to 65535 without leading zeros, and write an empty password without the colon. Remove whitespace and dot segments.";
it.each([
  [["preview", "--value", "{}"], ["key"], "Pass the setting key and one proposed JSON value with --value."],
  [["preview", key, "--value", "{}", "--goal", "stock"], ["goal"], "Use --goal with list."],
  [["preview", key, "--value", "{}", "--database-url="], ["database-url"], canonicalUrlHint],
  [["preview", "--database-url="], ["database-url"], canonicalUrlHint],
  [["preview", key, "--value", "{}", "--database-url", "postgresql:///shop"], ["database-url"], "Name the TCP host using the postgresql://user@host/database form."],
] as const)("names the invalid preview argument in %j", async (argv, path, hint) => {
  const { exit, output } = await run([...argv, "--json"]);
  expect(exit).toBe(64);
  expect(output).toBe(document(refuseSettingsPreview(refusalPrefix + "input_invalid", { path, hint })));
});

it("uses an app-owned checkout reader without falling back to catalogue timing", async () => {
  const reminder = "checkout_recovery_reminders";
  const app = "./app.ts";
  const readers = { [reminder]: async () => ({ present: false as const, effective: { checkoutRecovery: [] } }) };
  const host = { bind: vi.fn(async () => ({ readers })) };
  const { exit, output } = await run(["show", reminder, "--database-url", url, "--app", app, "--json"], { host });
  expect(exit).toBe(0);
  expect(output).toBe(document(await showSetting({ key: reminder }, readers)));
  expect(host.bind).toHaveBeenCalledExactlyOnceWith({ database: databaseOptions, app, configuration: undefined });
});

it("prints the reason and reference for a fact without value fields", async () => {
  const key = "shipping.addressRegions";
  const { exit, output } = await run(["show", key]);
  expect(exit).toBe(0);
  const reason = "The native address contract requires a postal code and has no region field.";
  expect(output.split(reason)).toHaveLength(2);
  expect(output).toContain("Change: docs/guide/");
  expect(output).not.toContain("Default:");
});

it.each([
  ["unknown configuration without URL", "unknown-store", []],
  ["empty configuration without URL", "", []],
  ["configuration URL redacted", "postgresql://untrusted.invalid/shop", []],
  ["unknown configuration before malformed URL", "unknown-store", ["--database-url", "postgresql://"]],
  ["unknown configuration before bad instant", "unknown-store", ["--as-of", "yesterday"]],
  ["unknown configuration with a connected URL", "unknown-store", ["--database-url", url]],
] as const)("returns configuration choices for %s", async (_, configuration, flags) => {
  const close = vi.fn(async () => {});
  const host = { bind: vi.fn(async () => ({ configurationIds: ["coffee", "supplements"], close })) };
  const { exit, output } = await run(["preview", key, "--value", "{}", "--app", "./app.ts", `--configuration=${configuration}`, ...flags, "--json"], { host });
  // The package exit vocabulary classifies an unknown configuration as input (64).
  expect(exit).toBe(64);
  expect(JSON.parse(output).refusal).toMatchObject({
    code: refusalPrefix + "configuration_unknown", path: ["configuration"],
    hint: `Unknown configuration ${configuration.includes("://") ? "ID" : JSON.stringify(configuration)}. Use one of these IDs: coffee, supplements.`,
  });
  expect(host.bind).toHaveBeenCalledExactlyOnceWith({ database: flags.some(flag => flag === url) ? databaseOptions : undefined, app: "./app.ts", configuration });
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  ["known configuration without URL", "{}", [], "connection_required", [], 1, true],
  ["known configuration before bad instant", "{}", ["--as-of", "yesterday"], "input_invalid", ["asOf"], 64, true],
  ["known configuration before malformed URL", "{}", ["--database-url", "postgresql://"], "input_invalid", ["database-url"], 64, true],
  ["malformed proposal before configuration", "{", [], "json_invalid", ["proposed"], 64, false],
] as const)("preserves preview admission order for %s", async (_, proposal, flags, code, path, status, bindCalled) => {
  const preview = vi.fn(async () => ({ schemaVersion: 1 as const }));
  const close = vi.fn(async () => {});
  const host = { bind: vi.fn(async () => ({ previewers: { [key]: preview }, close })) };
  const { exit, output } = await run(["preview", key, "--value", proposal, "--app", "./app.ts", "--configuration", "coffee", ...flags, "--json"], { host });
  expect(exit).toBe(status);
  expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, refusal: { code: refusalPrefix + code, path } });
  if (bindCalled) expect(host.bind).toHaveBeenCalledExactlyOnceWith({ database: undefined, app: "./app.ts", configuration: "coffee" });
  else expect(host.bind).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledTimes(bindCalled ? 1 : 0);
  expect(preview).not.toHaveBeenCalled();
});

it.each([
  ["app without configuration or URL", ["--app", "./app.ts"], []],
  // The starter knew its own configurations; a package command needs a binding.
  ["configuration without app", ["--configuration", "coffee"], ["configuration"]],
] as const)("refuses preview for %s without loading an app", async (_, args, path) => {
  const host = { bind: vi.fn() };
  const { exit, output } = await run(["preview", key, "--value", "{}", ...args, "--json"], { host });
  expect(exit).toBe(1);
  expect(JSON.parse(output).refusal).toMatchObject({ code: refusalPrefix + "connection_required", path });
  expect(host.bind).not.toHaveBeenCalled();
});

it.each([
  ["policy_read_denied", ["current"], 1],
  ["stock_read_denied", ["skus"], 1],
  ["validation_denied", ["proposed"], 1],
  ["validation_missing", ["proposed"], 1],
  // Unexpected operational errors now use the package's unavailable exit code.
  ["unexpected", [], 74],
] as const)("forwards the connected preview refusal %s and closes its binding", async (reason, path, status) => {
  const code = refusalPrefix + reason;
  const preview = vi.fn(async () => refuseSettingsPreview(code));
  const close = vi.fn(async () => {});
  const { exit, output } = await run(["preview", key, "--value", "{}", "--database-url", url, "--app", "./app.ts", "--json"], {
    host: { bind: async () => ({ previewers: { [key]: preview }, close }) },
  });
  expect(exit).toBe(status);
  expect(JSON.parse(output).refusal).toMatchObject({ code, path });
  expect(preview).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});

it("renders completed preview text through the bound formatter", async () => {
  const preview = vi.fn(async () => ({ schemaVersion: 1 as const }));
  const formatPreview = vi.fn(() => "Current and estimated availability");
  const { exit, output } = await run(["preview", key, "--value", "{}", "--database-url", url, "--app", "./app.ts"], {
    host: { bind: async () => ({ previewers: { [key]: preview } }), formatPreview },
  });
  expect(exit).toBe(0);
  expect(formatPreview).toHaveBeenCalledExactlyOnceWith({ schemaVersion: 1 });
  expect(output).toBe("Current and estimated availability\n");
});

it.each(["open", "read", "close"])("reports an unavailable operation once when %s fails", async failed => {
  const fail = () => { throw new Error("sensitive connection details"); };
  const host = { bind: async () => {
    if (failed === "open") return fail();
    return {
      readers: { [key]: async () => failed === "read" ? fail() : { present: false as const } },
      close: async () => { if (failed === "close") fail(); },
    };
  } };
  const { exit, output } = await run(["show", key, "--database-url", url, "--json"], { host });
  expect(exit).toBe(74);
  expect(output).not.toContain("sensitive");
  expect(JSON.parse(output).refusal).toMatchObject({ code: "commerce_setting_read_unavailable", path: ["key"] });
});

it.each([[["--help"]], [["preview", "--help"]]] as const)("labels settings %j experimental and advertises --value and the exit codes", async argv => {
  const { exit, output } = await run([...argv]);
  expect(exit).toBe(0);
  expect(output.split("\n")[0]).toContain("openlup settings (experimental)");
  expect(output).toContain("--value -");
  expect(output).toMatch(/0 completed.*1 refused.*64 invalid syntax or input.*74 operation unavailable/u);
});

it("advertises check in top-level help and returns dedicated help for every subcommand", async () => {
  const top = await run(["--help"]);
  expect(top.exit).toBe(0);
  expect(top.output).toContain("check --app <module>");

  for (const [argv, expectedFirstLine] of [
    [["list", "--help"], "openlup settings (experimental) list "],
    [["show", "--help"], "openlup settings (experimental) show "],
    [["preview", "--help"], "openlup settings (experimental) preview "],
    [["explain", "--help"], "openlup settings (experimental) explain "],
    [["check", "--help"], "openlup settings check --app <module>"],
    [["mcp", "--help"], "openlup settings (experimental) mcp "],
    [["--help", "mcp"], "openlup settings (experimental) mcp "],
  ] as const) {
    const textHelp = await run([...argv]);
    expect(textHelp.exit, argv.join(" ")).toBe(0);
    expect(textHelp.output.split("\n")[0], argv.join(" ")).toContain(expectedFirstLine);

    const jsonHelp = await run([...argv, "--json"]);
    expect(jsonHelp.exit, argv.join(" ")).toBe(0);
    expect(JSON.parse(jsonHelp.output)).toEqual({ schemaVersion: 1, help: textHelp.output.trimEnd() });
  }
});

it("shows versioned JSON help before checking required arguments", async () => {
  const bind = vi.fn();
  const { exit, output } = await run(["--json", "--help", "preview"], { host: { bind } });
  expect(exit).toBe(0);
  expect(JSON.parse(output)).toEqual({ schemaVersion: 1, help: expect.stringContaining("openlup settings (experimental)") });
  expect(bind).not.toHaveBeenCalled();
});

const checkArgs = ["check", "--app", "./app.ts", "--configuration", "sample", "--json"];
const minimumFile = { configuration: "sample", entries: {} };
const checks = (loadCheck: NonNullable<NonNullable<Parameters<typeof runSettingsCommand>[2]>["loadCheck"]>) =>
  ({ bind: vi.fn(), loadCheck });

it.each([
  ["sync pass", () => {}, 0, { state: "passed" }],
  ["async resolve", () => Promise.resolve(), 0, { state: "passed" }],
  ["sync throw", () => { throw new Error("  invalid\n config " + "x".repeat(200)); }, 1,
    { state: "failed", message: "invalid config " + "x".repeat(165) }],
  ["async reject", () => Promise.reject(new Error("async refusal")), 1, { state: "failed", message: "async refusal" }],
  ["thrown string", () => { throw "invalid string"; }, 1, { state: "failed", message: "invalid string" }],
  ["message object", () => { throw { message: "invalid object" }; }, 1, { state: "failed", message: "invalid object" }],
  ["unreadable message", () => { throw { get message() { throw new Error("getter failed"); } }; }, 1,
    { state: "failed", message: "Application validation failed." }],
  ["generic thrown value", () => { throw 42; }, 1, { state: "failed", message: "Application validation failed." }],
  ["no validator", undefined, 0, { state: "not-provided" }],
] as const)("checks %s", async (_, validate, status, appValidation) => {
  const load = vi.fn(async () => ({ file: { ...minimumFile, validate } }));
  const host = checks(load);
  const result = await run(checkArgs, { host });
  expect(result.exit).toBe(status);
  expect(JSON.parse(result.output)).toMatchObject({
    schemaVersion: 1, configuration: "sample", state: status === 0 ? "checked" : "invalid", appValidation,
  });
  expect(load).toHaveBeenCalledExactlyOnceWith({ app: "./app.ts", configuration: "sample" });
  expect(host.bind).not.toHaveBeenCalled();
});

it.each([
  ["missing binding", async () => ({}), 2, { state: "unknown", configuration: null }],
  ["unknown configuration", async () => ({ configurationIds: ["coffee"] }), 64,
    { refusal: { path: ["configuration"], hint: expect.stringContaining("coffee") } }],
  ["factory unavailable", async () => undefined, 74, { refusal: { path: ["app"], hint: expect.stringContaining("createSettingsBindings") } }],
  ["factory throws", async () => { throw new Error("  rejected\n edit "); }, 1,
    { state: "invalid", appValidation: { state: "failed", phase: "load", message: "rejected edit" } }],
] as const)("reports %s in the versioned check", async (_, load, status, expected) => {
  const { exit, output } = await run(checkArgs, { host: checks(load) });
  expect(exit).toBe(status);
  expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, ...expected });
});

it.each([
  ["short string", new Error("x_invalid", { cause: "a.b: must be positive" }), "x_invalid (a.b: must be positive)"],
  ["no cause", new Error("x_invalid"), "x_invalid"],
  ["empty string", new Error("x_invalid", { cause: "" }), "x_invalid"],
  ["non-string cause", new Error("x_invalid", { cause: 42 }), "x_invalid"],
  ["301-character string", new Error("x_invalid", { cause: "a".repeat(301) }), "x_invalid"],
  ["string with a line feed", new Error("x_invalid", { cause: "a.b: must be positive\nsecond line" }), "x_invalid"],
] as const)("reports a %s cause on check load and validation failures", async (_, error, message) => {
  const fail = () => { throw error; };
  const loaded = await run(checkArgs, { host: checks(async () => fail()) });
  const validated = await run(checkArgs, { host: checks(async () => ({ file: { ...minimumFile, validate: fail } })) });
  expect(loaded.exit).toBe(1);
  expect(validated.exit).toBe(1);
  expect(JSON.parse(loaded.output)).toMatchObject({
    state: "invalid", appValidation: { state: "failed", phase: "load", message },
  });
  expect(JSON.parse(validated.output)).toMatchObject({
    state: "invalid", appValidation: { state: "failed", message },
  });
});

it.each([
  [["check"], "app"], [["check", "--database-url", url], "database-url"],
  [[...checkArgs, "--database-url", url], "database-url"],
  [[...checkArgs, "--database-url="], "database-url"], [[...checkArgs, "--value", "{}"], "value"],
  [[...checkArgs, "--sku", "A"], "sku"], [[...checkArgs, "--as-of", asOf], "as-of"],
  [[...checkArgs, "--goal", "stock"], "goal"], [[...checkArgs, key], "key"],
  [[...checkArgs, "--unknown"], "unknown"], [[...checkArgs, "--app"], "app"],
] as const)("refuses invalid check arguments %j without a load", async (args, field) => {
  const load = vi.fn();
  const { exit, output } = await run([...args, "--json"], { host: checks(load) });
  expect(exit).toBe(64);
  const { refusal } = JSON.parse(output);
  expect(refusal.path).toEqual([field]);
  if (field === "database-url") expect(refusal.hint).toContain("Use settings preview");
  expect(load).not.toHaveBeenCalled();
});

const cyclic: { self?: unknown } = {};
cyclic.self = cyclic;
it.each([
  [key, cyclic], [key, undefined], [key, () => {}], [key, NaN],
  [key, { nested: undefined }], [key, Array(1)], ["checkout_recovery_reminders", 1n],
] as const)("locates an unreportable value for %s without a schema failure", async (setting, value) => {
  const host = checks(async () => ({ file: { ...minimumFile, entries: { [setting]: { value } } } }));
  const { exit, output } = await run(checkArgs, { host });
  expect(exit).toBe(1);
  const row = JSON.parse(output).rows.find((item: { key: string }) => item.key === setting);
  expect(row).toMatchObject({ file: { state: "unreportable", message: "Value cannot be reported as JSON." }, validation: { state: "not-validated" } });
  expect(row.file).not.toHaveProperty("value");
  const text = await run(checkArgs.filter(arg => arg !== "--json"), { host });
  expect(text.output).toContain(`${setting}: file unreportable, schema not-validated`);
});

it.each([
  ['{"revision":"local","renewalProtectionDays":14,"__proto__":{"custom":true}}', []],
  ['{"revision":"local","renewalProtectionDays":{"__proto__":{"custom":true}}}', ["renewalProtectionDays"]],
] as const)("validates and emits the original value %s", async (raw, path) => {
  const host = checks(async () => ({
    file: { ...minimumFile, entries: { [key]: { value: JSON.parse(raw) } } },
  }));
  const { exit, output } = await run(checkArgs, { host });
  expect(exit).toBe(1);
  expect(output).toContain(`"file":{"state":"present","value":${raw}}`);
  const row = JSON.parse(output).rows.find((item: { key: string }) => item.key === key);
  expect(row.validation).toEqual({ state: "invalid", paths: [path], messages: [expect.any(String)] });
  expect(row.validation.messages[0].length).toBeGreaterThan(0);
  const textCheck = await run(checkArgs.filter(arg => arg !== "--json"), { host });
  expect(textCheck.exit).toBe(1);
  expect(textCheck.output).toContain(
    `${key}: file present, schema invalid at ${path.join(".") || "<value>"}: ${row.validation.messages[0]}`,
  );
});

it.each(["list", "check"])("warns once about unmatched value-only keys in %s without reading them", async command => {
  const read = vi.fn(() => { throw new Error("unexpected value read"); });
  const installed = { value: parityValue, location: { file: "policy.ts", symbol: "inventory" } };
  const entries = { [key]: installed };
  const args = [command, ...appArgs, "--json"];
  const baseline = await run(args, { host: checks(async () => ({ file: { ...minimumFile, entries } })) });
  const result = await run(args, { host: checks(async () => ({ file: { ...minimumFile, entries: {
    ...entries, "z.legacy": { get value() { return read(); } }, "a.legacy": { get value() { return read(); } },
  } } })) });
  expect([result.exit, result.output]).toEqual([baseline.exit, baseline.output]);
  expect(baseline.warnings).toEqual([]);
  expect(result.warnings).toEqual([
    'Settings app: value reported without a descriptor for "a.legacy", "z.legacy". Add a descriptor to each named file.entries entry. See node_modules/@openlup/core/docs/guide/how-to/operate/configure-settings.md#declare-a-setting-of-your-own.\n',
  ]);
  expect(read).not.toHaveBeenCalled();
});

it("checks every packaged schema against its default and valid examples", async () => {
  const { loadSettingsCatalogue } = await import("../../src/operations/server/settingsCatalog.js");
  const entries = loadSettingsCatalogue().entries.filter(entry => "fallback" in entry).filter(entry =>
    (entry.kind === "code" || entry.kind === "installed") && entry.schema);
  expect(entries.map(entry => entry.key)).toEqual([
    "catalog.bundleAvailabilityPolicy",
    "checkout.resumeWindowMinutes",
    "communications.terminalPayloadRetentionDays",
    "inventory.offerLowStockThreshold",
    key,
    "market.fiscalProfile",
    "market.settlementProfile",
    "shipping_flat_minor",
    "subscription_minimum_base_units",
    "subscription_sized_intro_phase",
  ]);
  for (const entry of entries) {
    const values = [
      ...(entry.fallback !== null ? [entry.fallback] : []),
      ...entry.examples.filter(example => !example.code).map(example => example.value),
    ];
    expect(values.length, entry.key).toBeGreaterThan(0);
    for (const value of values) {
      const host = checks(async () => ({ file: { ...minimumFile, entries: { [entry.key]: { value } } } }));
      const { exit, output } = await run(checkArgs, { host });
      expect(exit, entry.key).toBe(0);
      expect(JSON.parse(output).rows.find((row: { key: string }) => row.key === entry.key).validation).toEqual({ state: "valid" });
    }
  }
});

it("keeps the guide's app declaration identical to the typechecked binding", () => {
  const guide = readFileSync(new URL("../../../core/docs/guide/how-to/operate/configure-settings.md", import.meta.url), "utf8");
  const section = guide.split("## Declare a setting of your own\n")[1]!.split("\n## ")[0]!;
  const snippets = [...section.matchAll(/^```ts[^\n]*\n([\s\S]+?)^```/gmu)].map(([, code]) => code);
  const fixture = new URL("./fixtures/settings-guide/owned/", import.meta.url);
  const gift = readFileSync(new URL("gift.config.ts", fixture), "utf8");
  const binding = readFileSync(new URL("settings-host.ts", fixture), "utf8");
  expect(snippets).toEqual([gift, binding.split("\nexport function createSettingsBindings")[0]]);
});

const feeKey = "gift.wrapFeeMinor";
const giftKey = "gift.enabled";
const giftPath = "owned/gift.config.ts";
const feeEffect = "New gift quotes use this fee after deployment.";
const missingApp = "Check the --app path and the createSettingsBindings export.";
const appArgs = ["--app", "./app.ts"];
const appPreviewRefusal = refuseSettingsPreview("commerce_setting_preview_unsupported", {
  path: ["key"],
  hint: `${feeKey} is an application setting without a preview. Read it with settings show ${feeKey} and validate an edit with settings check.`,
});

function appFixture(readFee: () => unknown = () => "150", schema: ZodType = z.coerce.number().int().refine(n => n !== 151)) {
  return {
    file: {
      configuration: "sample",
      validate() {},
      entries: {
        [feeKey]: {
          get value() { return readFee(); },
          location: { file: giftPath, symbol: feeKey },
          descriptor: {
            domain: "gift", goal: "Set the gift wrapping fee in minor units.",
            effect: { appliesTo: feeEffect, impact: "money", frozenOn: [] }, schema,
          },
        },
        [giftKey]: {
          value: true,
          location: { file: giftPath, symbol: giftKey },
          descriptor: {
            domain: "gift", goal: "Offer gift wrapping.",
            effect: { appliesTo: "New gift quotes offer wrapping after deployment.", impact: "operations", frozenOn: [] },
          },
        },
        [key]: {
          value: { revision: "local", renewalProtectionDays: 14 },
          location: { file: "owned/store.config.ts", symbol: "inventory.renewalProtection" },
        },
      },
    },
  } satisfies SettingsAppBindings;
}

it.each(["text", "json"])("refuses preview of a declared application setting in %s", async format => {
  const loadCheck = vi.fn(async () => appFixture());
  const host = checks(loadCheck);
  const argv = ["preview", feeKey, "--value", "150", ...appArgs];
  const { exit, output } = await run(format === "json" ? [...argv, "--json"] : argv, { host });
  const { code, rule, hint, remediation } = appPreviewRefusal.refusal;
  expect(exit).toBe(1);
  expect(output).toBe(format === "json" ? document(appPreviewRefusal)
    : [code, rule, hint, remediation.action, remediation.command, ""].join("\n"));
  expect(loadCheck).toHaveBeenCalledExactlyOnceWith({ app: "./app.ts", configuration: undefined });
  expect(host.bind).not.toHaveBeenCalled();
});

it("keeps the unknown refusal for an application key without --app", async () => {
  const loadCheck = vi.fn(async () => appFixture());
  const { exit, output } = await run(["preview", feeKey, "--value", "150", "--json"], { host: checks(loadCheck) });
  expect(exit).toBe(1);
  expect(output).toBe(document(refuseSettingsPreview("commerce_setting_unknown")));
  expect(loadCheck).not.toHaveBeenCalled();
});

it.each([
  ["nonfinite proposal", ["--value", "1e999"], ["proposed"]],
  ["invalid as-of instant", ["--value", "{}", "--as-of", "not-a-date"], ["asOf"]],
  ["invalid database-url", ["--value", "{}", "--database-url", "http://bad"], ["database-url"]],
] as const)("validates preview %s before refusing an application key as unsupported", async (_, flags, path) => {
  const loadCheck = vi.fn(async () => appFixture());
  const host = checks(loadCheck);
  const { exit, output } = await run(["preview", feeKey, ...flags, ...appArgs, "--json"], { host });
  expect(exit).toBe(64);
  expect(JSON.parse(output)).toMatchObject({
    schemaVersion: 1,
    refusal: { code: "commerce_setting_preview_input_invalid", path },
  });
  expect(loadCheck).not.toHaveBeenCalled();
  expect(host.bind).not.toHaveBeenCalled();
});

it("keeps P10 unknown configuration precedence over invalid asOf on an application key", async () => {
  const loadCheck = vi.fn(async () => appFixture());
  const close = vi.fn(async () => {});
  const host = {
    loadCheck,
    bind: vi.fn(async () => ({ configurationIds: ["west"], close })),
  };
  const { exit, output } = await run(
    ["preview", feeKey, "--value", "{}", "--as-of", "not-a-date", ...appArgs, "--configuration", "missing", "--json"],
    { host },
  );
  expect(exit).toBe(64);
  expect(JSON.parse(output)).toMatchObject({
    schemaVersion: 1,
    refusal: { code: "commerce_setting_preview_configuration_unknown", path: ["configuration"] },
  });
  expect(loadCheck).not.toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});

it.each([
  ["checkout_recovery_reminders", "commerce_setting_preview_unsupported"],
  [key, "commerce_setting_preview_connection_required"],
] as const)("keeps the packaged %s preview refusal without loading the app", async (packagedKey, code) => {
  const loadCheck = vi.fn(async () => appFixture());
  const host = checks(loadCheck);
  const { exit, output } = await run(["preview", packagedKey, "--value", "{}", "--json", ...appArgs], { host });
  expect(exit).toBe(1);
  expect(output).toBe(document(refuseSettingsPreview(code)));
  expect(loadCheck).not.toHaveBeenCalled();
  expect(host.bind).not.toHaveBeenCalled();
});

const parityModes = ["no app", "healthy app", "throwing app"] as const;
const parityValue = { revision: "local", renewalProtectionDays: 14 };
const parityArgs = ["--database-url", url];
const parityPreviewArgs = ["--value", JSON.stringify(parityValue), "--as-of", asOf, ...parityArgs];

function boundParityHost(mode: typeof parityModes[number]): NonNullable<Parameters<typeof runSettingsCommand>[2]> {
  const load = async () => {
    if (mode === "throwing app") throw new Error("rejected edit");
    return { file: { configuration: "sample", entries: { [key]: { value: parityValue } }, validate() {} } };
  };
  return {
    loadCheck: load,
    async bind({ app }) {
      if (app) await load();
      return {
        readers: {
          [key]: async () => ({ present: true, value: parityValue, revision: "local" }),
          ...(app ? { checkout_recovery_reminders: async () => ({ present: false as const, effective: { checkoutRecovery: [] } }) } : {}),
        },
        previewers: app ? { [key]: async () => ({ schemaVersion: 1, key, proposed: parityValue }) } : {},
      };
    },
  };
}

it("keeps N3a package invocations bytes and exits in both modes with no app, a healthy app or a throwing app", async () => {
  const catalogue = listSettings({});
  if (!("entries" in catalogue)) throw new Error("Unable to read the package catalogue");
  const cases = [
    ["list"], ["list", "--goal", " "], ["list", "--goal", "qzxunique"], ["explain", "commerce_setting_unknown"],
    ...catalogue.entries.flatMap(({ key }) => [["list", "--goal", key], ["show", key], ["explain", key]]),
  ];
  const bytes = [];
  const loadHealthy = vi.fn(async () => appFixture(() => { throw new Error("unexpected value read"); }));
  const loadBroken = vi.fn(async () => { throw new Error("rejected\nedit"); });
  for (const json of [false, true]) for (const args of cases) {
    const argv = json ? [...args, "--json"] : args;
    const { exit, output } = await run(argv);
    bytes.push([exit, output]);
    for (const load of [loadHealthy, loadBroken]) {
      load.mockClear();
      const app = await run([...argv, ...appArgs], { host: checks(load) });
      const list = args[0] === "list" && exit === 0;
      expect(load).toHaveBeenCalledTimes(list ? 1 : 0);
      expect(app.exit, argv.join(" ")).toBe(exit);
      let projected = app.output;
      if (list && load === loadHealthy) {
        if (json) {
          const result = JSON.parse(projected);
          result.entries = result.entries.filter((entry: { key: string }) => entry.key !== feeKey && entry.key !== giftKey);
          projected = document(result);
        } else {
          projected = projected.split(/(?=^[^\s])/mu)
            .filter(line => !line.startsWith(feeKey + " ") && !line.startsWith(giftKey + " ")).join("");
        }
      } else if (list && load === loadBroken) {
        if (json) {
          const { appBindingWarning, ...rest } = JSON.parse(projected);
          expect(appBindingWarning).toBe("rejected edit");
          projected = document(rest);
        } else {
          const prefix = "Warning: application settings unavailable — rejected edit\n";
          expect(projected.startsWith(prefix)).toBe(true);
          projected = projected.slice(prefix.length);
        }
      }
      expect(projected, argv.join(" ")).toBe(output);
      expect(app.warnings).toEqual(list && load === loadBroken ? ["Settings app: rejected edit\n"] : []);
    }
  }
  // N3a bytes with the six starter keys removed, the callback guide reference,
  // the unknown-key guidance, the text hint for an empty list, the clarified
  // six-reason vocabulary description for commerce.manualHoldReasons,
  // domain-guide change.reference links for all 47 cap and invariant entries,
  // "Default: none (see behavior below)" for null fallbacks (K6),
  // Stage 4 Wave 4B packaged callback and single-row installed entries,
  // Stage 4 Wave 4C packaged code (D1-D3, A16, E12) and multi-row installed entries (B3, B5),
  // and the market fiscal profile, tax adapter choices and tax class map.
  expect(createHash("sha256").update(JSON.stringify(bytes)).digest("hex"))
    .toBe("423fdc6111dcc42b71ba35b7dddfb618ded735ec11338589d49564de6d165c7a");

  // The N3a fixture holds raw stdout and exit for each distinct connected or check outcome.
  type Expected = {
    outputs: [number, string][];
    rows: Record<string, Record<"text" | "json", Record<typeof parityModes[number], number>>>;
  };
  const expected: Expected = JSON.parse(readFileSync(new URL("./settingsBoundParity.main.json", import.meta.url), "utf8"));
  const bound = [
    ...catalogue.entries.map(entry => ({
      args: ["show", entry.key, ...parityArgs],
      fixture: entry.kind === "installed" ? `show ${entry.key}` : undefined,
    })),
    ...catalogue.entries.map(entry => ({
      args: ["preview", entry.key, ...parityPreviewArgs],
      fixture: entry.key === key ? "preview inventory" : "preview unsupported",
    })),
    { args: ["check"], fixture: "check" },
  ];
  for (const format of ["text", "json"] as const) for (const { args, fixture } of bound) {
    const outputArgs = format === "json" ? ["--json"] : [];
    // Non-installed show returns the offline document already pinned above.
    const offline = fixture ? undefined : bytes[(format === "json" ? cases.length : 0)
      + cases.findIndex(row => row[0] === "show" && row[1] === args[1])]!;
    for (const mode of parityModes) {
      const argv = [...args, ...(mode === "no app" ? [] : appArgs), ...outputArgs];
      const { exit, output, warnings } = await run(argv, { host: boundParityHost(mode) });
      expect([exit, output], `${mode}: ${argv.join(" ")}`).toEqual(fixture ? expected.outputs[expected.rows[fixture]![format][mode]] : offline);
      expect(warnings).toEqual([]);
    }
  }
});

it.each([
  [["list"], [giftKey, feeKey], undefined, 0],
  [["list", "--goal", "gift wrapping fee"], [feeKey], undefined, 0],
  [["list", "--goal", "qzxunique"], [], undefined, 0],
  [["show", feeKey], undefined, { state: "file", configuration: "sample", value: "150" }, 1],
  [["explain", feeKey], undefined, { state: "offline" }, 0],
] as const)("discovers declarations with %j and reads only a requested value", async (args, keys, observation, calls) => {
  const readFee = vi.fn(() => "150");
  const { exit, output } = await run([...args, ...appArgs, "--json"], { host: checks(async () => appFixture(readFee)) });
  expect(exit).toBe(0);
  const result = JSON.parse(output);
  expect(result.schemaVersion).toBe(1);
  if (keys) expect(result.entries.map((entry: { key: string }) => entry.key).filter((key: string) => key.startsWith("gift."))).toEqual(keys);
  else expect(result).toMatchObject({
    setting: { key: feeKey, kind: "code", schema: { type: "integer" }, change: { file: giftPath, symbol: feeKey } }, observation,
  });
  expect(readFee).toHaveBeenCalledTimes(calls);
});

it.each([["150", "valid"], ["151", "invalid"]] as const)("checks the original fee %s against the app schema and preserves packaged rows", async (value, state) => {
  const readFee = vi.fn(() => value);
  const app = appFixture(readFee);
  const valueOnly = { ...app.file, entries: { [key]: app.file.entries[key] } };
  const baseline = JSON.parse((await run(checkArgs, { host: checks(async () => ({ file: valueOnly })) })).output);
  const { exit, output } = await run(checkArgs, { host: checks(async () => app) });
  expect(exit).toBe(state === "valid" ? 0 : 1);
  const { rows, ...report } = JSON.parse(output);
  const { rows: packagedRows, ...packagedReport } = baseline;
  expect(report).toEqual({ ...packagedReport, state: state === "valid" ? "checked" : "invalid" });
  expect(rows.filter((row: { key: string }) => !row.key.startsWith("gift."))).toEqual(packagedRows);
  expect(rows.find((row: { key: string }) => row.key === feeKey)).toEqual({
    key: feeKey, file: { state: "present", location: { file: giftPath, symbol: feeKey }, value },
    validation: state === "valid" ? { state } : { state, paths: [[]], messages: ["Invalid input"] },
    effect: feeEffect, takesEffect: `${giftPath} ${feeKey}`, kind: "code",
  });
  expect(rows.find((row: { key: string }) => row.key === giftKey).validation).toEqual({ state: "not-validated" });
  expect(readFee).toHaveBeenCalledOnce();
});

it.each([
  ["list"], ["show", feeKey], ["explain", feeKey], ["check"],
])("canonicalizes shuffled declaration members for %s", async (...args) => {
  const shuffled = appFixture();
  const fee = shuffled.file.entries[feeKey];
  const effect = Object.fromEntries(Object.entries(fee.descriptor.effect).reverse());
  Object.defineProperties(fee, {
    descriptor: { value: Object.fromEntries(Object.entries({ ...fee.descriptor, effect }).reverse()) },
    location: { value: { symbol: feeKey, file: giftPath } },
  });
  for (const json of [false, true]) {
    const argv = [...args, ...appArgs, ...(json ? ["--json"] : [])];
    const expected = await run(argv, { host: checks(async () => appFixture()) });
    const actual = await run(argv, { host: checks(async () => shuffled) });
    expect(expected.exit).toBe(0);
    expect([actual.exit, actual.output]).toEqual([expected.exit, expected.output]);
    if (args[0] === "check" && json) {
      const { rows } = JSON.parse(actual.output);
      expect(rows.find((row: { key: string }) => row.key === feeKey).takesEffect).toBe(`${giftPath} ${feeKey}`);
    }
  }
});

it("uses the packaged value descriptor member order for declared show JSON", async () => {
  const app = await run(["show", feeKey, ...appArgs, "--json"], { host: checks(async () => appFixture()) });
  const pkg = await run(["show", key, "--json"]);
  expect([app.exit, pkg.exit]).toEqual([0, 0]);
  const { setting: declared } = JSON.parse(app.output);
  const { setting: packaged } = JSON.parse(pkg.output);
  expect(Object.keys(declared)).toEqual(Object.keys(packaged));
  for (const field of ["effect", "runtime"]) {
    expect(Object.keys(declared[field])).toEqual(Object.keys(packaged[field]));
  }
  expect(Object.keys(declared.change)).toEqual(["file", "symbol"]);
});

const ownProtoJson = '{"__proto__":{"flag":true}}';

it("reports original JSON with own special keys", async () => {
  const raw = JSON.parse(ownProtoJson);
  const host = checks(async () => appFixture(() => raw, z.unknown()));
  const { output, exit } = await run(["show", feeKey, ...appArgs, "--json"], { host });
  expect(exit).toBe(0);
  expect(output).toContain(`"value":${ownProtoJson}`);
});

it.each(["show", "explain"])("preserves own metadata and projected properties in %s", async command => {
  const raw = '{"__proto__":{"flag":true}}';
  const authored = JSON.parse(raw);
  const bindings = appFixture(() => "150", z.object({ ["__proto__"]: z.number() }));
  Object.assign(bindings.file.entries[feeKey].descriptor, { fallback: authored, examples: [{ value: authored }] });
  const { exit, output } = await run([command, feeKey, ...appArgs, "--json"], { host: checks(async () => bindings) });
  expect(exit).toBe(0);
  const { setting } = JSON.parse(output);
  expect(JSON.stringify(setting.fallback)).toBe(raw);
  expect(JSON.stringify(setting.examples)).toBe(`[{"value":${raw}}]`);
  expect(Object.hasOwn(setting.schema.properties, "__proto__")).toBe(true);
  expect(setting.schema.properties["__proto__"]).toEqual({ type: "number" });
  expect(setting.schema.required).toEqual(["__proto__"]);
});

it.each([
  ["an unset value", () => undefined, 0, 0],
  ["a throwing getter", () => { throw new Error("private accessor detail"); }, 74, 1],
  ["a non-JSON value", () => Number.POSITIVE_INFINITY, 74, 1],
] as const)("reports %s in show and check", async (_, readFee, showExit, checkExit) => {
  const read = vi.fn(readFee);
  const host = checks(async () => appFixture(read));
  const show = await run(["show", feeKey, ...appArgs, "--json"], { host });
  expect(show.exit).toBe(showExit);
  expect(JSON.parse(show.output)).toMatchObject(showExit === 0 ? {
    schemaVersion: 1, setting: { key: feeKey }, observation: { state: "offline" },
  } : {
    schemaVersion: 1, refusal: { code: "commerce_setting_read_unavailable", path: ["file", "entries", feeKey, "value"] },
  });
  expect(show.output).not.toContain("private accessor detail");
  const check = await run(checkArgs, { host });
  expect(check.exit).toBe(checkExit);
  expect(JSON.parse(check.output)).toMatchObject({
    state: checkExit ? "invalid" : "checked", rows: expect.arrayContaining([expect.objectContaining({
      key: feeKey, file: checkExit ? { state: "unreportable", location: { file: giftPath, symbol: feeKey }, message: "Value cannot be reported as JSON." } : { state: "not-reported" },
      validation: { state: "not-validated" },
    })]),
  });
  expect(read).toHaveBeenCalledTimes(2);
});

it.each([
  ["a collision", key, z.number(), "is a packaged setting"],
  ["a schema conversion failure", feeKey, z.date(), "cannot be displayed"],
  ["a reference location", feeKey, z.number(), `Supply a file and symbol for ${feeKey}`, { reference: "docs/gift.md" }],
  ["an operation location", feeKey, z.number(), `Supply a file and symbol for ${feeKey}`, { operation: "setGiftFee" }],
] as const)("refuses %s before reading any value", async (_, declarationKey, schema, hint, location?) => {
  const read = vi.fn();
  const { file } = appFixture(read, schema);
  const entry = file.entries[feeKey];
  if (location) Object.defineProperty(entry, "location", { value: location });
  const bindings = { file: { ...file, entries: { [declarationKey]: entry } } };
  for (const args of [["list"], ["show", feeKey], ["explain", feeKey], ["check"]]) {
    const { exit, output } = await run([...args, ...appArgs, "--json"], { host: checks(async () => bindings) });
    expect(exit).toBe(64);
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, refusal: {
      code: "commerce_setting_read_input_invalid", path: ["file", "entries", declarationKey, "descriptor"],
      hint: expect.stringContaining(hint),
    } });
  }
  expect(read).not.toHaveBeenCalled();
});

it.each([
  ["missing factory or module", async () => undefined, 74, missingApp],
  ["throwing app", async () => { throw new Error("  rejected\nedit " + "x".repeat(200)); }, 1, "rejected edit " + "x".repeat(166)],
] as const)("reports a %s on the channels defined by P3 and P4", async (_, load, status, hint) => {
  const host = checks(load);
  for (const command of ["show", "explain"]) {
    const { exit, output, warnings } = await run([command, feeKey, ...appArgs, "--json"], { host });
    expect(exit).toBe(status);
    expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, refusal: { code: "commerce_setting_read_unavailable", path: ["app"], hint } });
    expect(warnings).toEqual([]);
  }
  const app = await run(["list", ...appArgs, "--json"], { host });
  const baseline = await run(["list", "--json"]);
  expect({ exit: app.exit, output: app.output }).toEqual({
    exit: baseline.exit,
    output: document({ ...JSON.parse(baseline.output), appBindingWarning: hint }),
  });
  expect(app.warnings).toEqual([`Settings app: ${hint}\n`]);
});

it.each([{}, appFixture()])("keeps unknown-key refusals for a healthy module without a matching declaration", async binding => {
  for (const command of ["show", "explain"]) {
    const args = [command, "gift.unknown", "--json"];
    const { exit, output } = await run([...args, ...appArgs], { host: checks(async () => binding) });
    const baseline = await run(args);
    expect({ exit, output }).toEqual({ exit: baseline.exit, output: baseline.output });
  }
});

const fixedApp = { app: "./app.ts" };
const connectedApp = { ...fixedApp, "database-url": url };
const nativeProposal = { renewalProtectionDays: 21, revision: "next" };
const validPreview = renewalStockProtectionPreviewResult.parse({
  schemaVersion: 1, key, asOf, proposed: nativeProposal, current: parityValue,
  difference: { renewalProtectionDays: 7 }, validation: { state: "valid", value: nativeProposal },
  effect: { existingReservations: "unchanged", newPurchaseAvailability: "equal-or-lower", skus: [] }, uncertainty: "fixture",
});

it.each([
  ["P01 app goal list", "list", { goal: "gift wrapping fee" }, ["--goal", "gift wrapping fee"], fixedApp, 0],
  ["P02 declared file value with selected configuration", "show", { key: feeKey }, [feeKey], { ...fixedApp, configuration: "west" }, 0],
  ["P02 declared file value with own __proto__", "show", { key: feeKey }, [feeKey], fixedApp, 0, ownProtoJson],
  ["P03 explain refusal code", "explain", { keyOrCode: "commerce_setting_unknown" }, ["commerce_setting_unknown"], fixedApp, 0],
  ["P03 explain selected declaration", "explain", { keyOrCode: feeKey }, [feeKey], { ...fixedApp, configuration: "west" }, 0],
  ["P04 show missing key", "show", {}, [], fixedApp, 64],
  ["P04 show empty key", "show", { key: "" }, [""], fixedApp, 64],
  ["P05 connected override", "show", { key }, [key], connectedApp, 0],
  ["P06 missing connected reader", "show", { key: "subscriber_winback_policy" }, ["subscriber_winback_policy"], connectedApp, 1],
  ["P06 unavailable store", "show", { key }, [key], { ...connectedApp, app: "unavailable" }, 74],
  ["P07 check ignores URL", "check", {}, [], connectedApp, 0],
  ["P07 check invalid", "check", {}, [], { app: "invalid" }, 1],
  ["P07 check unknown", "check", {}, [], { app: "unknown" }, 2],
  ["P07 check missing factory", "check", {}, [], { app: "missing" }, 74],
  ["P08 offline preview", "preview", { key, value: nativeProposal }, [key, "--value", JSON.stringify(nativeProposal)], fixedApp, 1],
  ["P08 declared application preview refusal", "preview", { key: feeKey, value: 150 }, [feeKey, "--value", "150"], fixedApp, 1],
  ["P09 preview missing key", "preview", { value: null }, ["--value", "null"], fixedApp, 64],
  ["P09 preview empty key", "preview", { key: "", value: null }, ["--value", "null", "--", ""], fixedApp, 64],
  ["P09 preview missing proposal", "preview", { key }, [key], fixedApp, 64],
  ["P10 unknown configuration precedes invalid asOf", "preview", { key, value: {}, asOf: "bad" },
    [key, "--value", "{}", "--as-of", "bad"], { ...connectedApp, configuration: "missing" }, 64],
  ["P11 valid preview", "preview", { key, value: nativeProposal, asOf },
    [key, "--value", JSON.stringify(nativeProposal), "--as-of", asOf], connectedApp, 0],
  ["P11 invalid-policy preview", "preview", { key, value: null, asOf }, [key, "--value", "null", "--as-of", asOf], connectedApp, 0],
  ["P13 selected list", "list", {}, [], { ...fixedApp, configuration: "west" }, 0],
  ["P13 selected package show", "show", { key }, [key], { ...fixedApp, configuration: "west" }, 0],
  ["P13 selected package explain", "explain", { keyOrCode: key }, [key], { ...fixedApp, configuration: "west" }, 0],
  ["P13 unknown package show configuration", "show", { key }, [key], { ...fixedApp, configuration: "missing" }, 64],
  ["P13 unknown package explain configuration", "explain", { keyOrCode: key }, [key], { ...fixedApp, configuration: "missing" }, 64],
  ["P13 selected connected show", "show", { key }, [key], { ...connectedApp, configuration: "west" }, 0],
  ["P13 selected check", "check", {}, [], { ...connectedApp, configuration: "west" }, 0],
  ["P13 unknown list configuration", "list", {}, [], { ...fixedApp, configuration: "missing" }, 64],
  ["P13 unknown show configuration", "show", { key }, [key], { ...connectedApp, configuration: "missing" }, 64],
  ["P13 unknown explain configuration", "explain", { keyOrCode: feeKey }, [feeKey], { ...fixedApp, configuration: "missing" }, 64],
] as const)("%s returns identical CLI and MCP documents", async (_, command, input, argv, context, exit, fileJson?) => {
  const loadCheck = vi.fn(async ({ app, configuration }: { app: string; configuration?: string }) => {
    if (app === "missing") return undefined;
    if (app === "unknown") return {};
    if (app === "invalid") throw new Error("rejected edit");
    if (configuration === "missing") return { configurationIds: ["west"] };
    const configured = fileJson === undefined
      ? appFixture(() => configuration === "west" ? 151 : 150, z.number())
      : appFixture(() => JSON.parse(fileJson), z.unknown());
    return { file: { ...configured.file!, configuration: configuration ?? "sample" } };
  });
  const close = vi.fn(async () => {});
  const preview = vi.fn(async (value: unknown) => value === null ? { ...validPreview, proposed: null,
    validation: { state: "invalid" as const, code: "inventory_renewal_protection_policy_invalid", rule: "policy", hint: "Use an object",
      remediation: { retry: true, action: "Repair", command: "openlup settings preview --help" } } } : validPreview);
  const bind = vi.fn(async ({ app, configuration }: Parameters<NonNullable<Parameters<typeof runSettingsCommand>[2]>["bind"]>[0]) => {
    if (configuration === "missing") return { configurationIds: ["west"], close };
    return { close, readers: { [key]: async () => {
      if (app === "unavailable") throw new Error("store unavailable");
      return { present: true as const, revision: "local", value: parityValue };
    } }, previewers: { [key]: preview } };
  });
  const launchFlags = Object.entries(context).map(([flag, value]) => `--${flag}=${value}`);
  const launch = settingsMcpContext(launchFlags);
  expect(launch.context).toEqual(context);
  const flags = launchFlags.filter(flag => !flag.startsWith("--database-url=") || command === "show" || command === "preview");
  const tool = settingsMcpTools(renewalStockProtectionPreviewResult).find(row => row.command === command)!;
  const host = { bind, loadCheck };
  const cli = await run([...flags, "--json", command, ...argv], { host });
  expect(cli.exit).toBe(exit);
  const result = await callSettingsTool(tool, input, launch.context!, host);
  expect(result).toEqual({ isError: exit !== 0, structuredContent: JSON.parse(cli.output),
    content: [{ type: "text", text: cli.output.trimEnd() }] });
  if (fileJson !== undefined) {
    expect(JSON.stringify(result.structuredContent)).toContain(`"value":${fileJson}`);
    expect(result.content[0]?.text).toContain(`"value":${fileJson}`);
  }
  if (command === "show" && "database-url" in context) {
    expect(bind).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenLastCalledWith({ database: databaseOptions, app: context.app,
      configuration: "configuration" in context ? context.configuration : undefined });
    expect(close).toHaveBeenCalledTimes(2);
  }
  if ("configuration" in context && (command === "list" || command === "explain" || command === "check" || !("database-url" in context))) {
    expect(loadCheck).toHaveBeenLastCalledWith({ app: context.app, configuration: context.configuration });
    if (context.configuration === "missing") expect(JSON.parse(cli.output).refusal).toMatchObject({
      code: "commerce_setting_read_input_invalid", path: ["configuration"], hint: 'Unknown configuration "missing". Use one of these IDs: west.',
    });
  }
  if (command === "check" || command === "preview" && !("database-url" in context)) expect(bind).not.toHaveBeenCalled();
  if (command === "preview" && exit !== 0) expect(preview).not.toHaveBeenCalled();
});

it.each([
  ["incomplete output", { schemaVersion: 1 as const }],
  ["extra field with the platform's strict schema", { ...validPreview, extra: true }],
] as const)("P11 rejects %s", async (_, output) => {
  const tool = settingsMcpTools(renewalStockProtectionPreviewResult).find(row => row.command === "preview")!;
  const result = await callSettingsTool(tool, { key, value: nativeProposal, asOf }, connectedApp,
    { bind: async () => ({ previewers: { [key]: async () => output } }) });
  expect(result).toEqual({ isError: true, content: [{ type: "text",
    text: "The settings command returned an invalid document. Check the installed package version and app binding." }] });
});

it.each([url, url + " ", url + "?host=other.invalid", url.replace("/shop", "/%ZZ"), url.replace("/shop", "/")])("P12 uses shared named-store launch admission", async (candidate) => {
  const launch = settingsMcpContext([`--database-url=${candidate}`]);
  if (candidate === url) expect(launch.context).toEqual({ "database-url": url });
  else {
    const bind = vi.fn();
    const cli = await run(["show", key, `--database-url=${candidate}`, "--json"], { host: { bind } });
    expect(cli.exit).toBe(64);
    expect(launch.hint).toBe(JSON.parse(cli.output).refusal.hint);
    expect(bind).not.toHaveBeenCalled();
  }
});

it("refuses a non-canonical MCP launch URL before reading or writing protocol frames", async () => {
  const write = vi.fn();
  const warn = vi.fn();
  const bind = vi.fn();
  const input = { [Symbol.asyncIterator]: vi.fn(() => { throw new Error("unexpected frame input"); }) };
  expect(await runSettingsCommand(["mcp", `--database-url=${url} `], {
    write, warn, input, readStdin: async () => { throw new Error("unexpected proposal input"); },
  }, { bind, previewResultSchema: renewalStockProtectionPreviewResult })).toBe(64);
  expect(warn).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^Supply a canonical [^\n]+\n$/u));
  expect(write).not.toHaveBeenCalled();
  expect(input[Symbol.asyncIterator]).not.toHaveBeenCalled();
  expect(bind).not.toHaveBeenCalled();
});

it.each([
  ["throwing binding", async () => { throw new Error("rejected edit"); }, 74, "Settings app: rejected edit\n"],
  ["throw without a message", async () => { throw new Error(); }, 74,
    "Settings app: Check the --app path and the createSettingsBindings export.\n"],
  ["missing binding", async () => undefined, 74, "Settings app: Check the --app path and the createSettingsBindings export.\n"],
  ["unknown configuration", async () => ({ configurationIds: ["west"] }), 64,
    'Unknown configuration "missing". Use one of these IDs: west.\n'],
] as const)("refuses MCP launch with a %s before reading or writing protocol frames", async (_, load, exit, warning) => {
  const write = vi.fn();
  const warn = vi.fn();
  const loadCheck = vi.fn(load);
  const input = { [Symbol.asyncIterator]: vi.fn(() => { throw new Error("unexpected frame input"); }) };
  expect(await runSettingsCommand(["mcp", "--app=./app.ts", "--configuration=missing"], {
    write, warn, input, readStdin: async () => "",
  }, { bind: vi.fn(), loadCheck, previewResultSchema: renewalStockProtectionPreviewResult })).toBe(exit);
  expect(loadCheck).toHaveBeenCalledExactlyOnceWith({ app: "./app.ts", configuration: "missing" });
  expect(warn).toHaveBeenCalledExactlyOnceWith(warning);
  expect(write).not.toHaveBeenCalled();
  expect(input[Symbol.asyncIterator]).not.toHaveBeenCalled();
});

it.each([
  ["settings_show", {}, "key"],
  ["settings_explain", {}, "keyOrCode"],
  ["settings_preview", { value: null }, "key"],
  ["settings_preview", { key }, "value"],
  ["settings_preview", {}, undefined],
  ["settings_preview", { value: null, skus: 1 }, undefined],
] as const)("refuses %s arguments %j and continues the session", async (name, args, field) => {
  using dispatch = vi.spyOn(await import("../../src/operations/server/settingsCommand.js"), "runSettingsCommand");
  const input = (async function* () {
    yield Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) + "\n");
    yield Buffer.from('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  })();
  const write = vi.fn<(line: string) => void>();
  const bind = vi.fn();
  const loadCheck = vi.fn(async () => ({}));
  expect(await runSettingsCommand(["mcp", "--app=./app.ts", `--database-url=${url}`], { write, input, readStdin: async () => "" }, {
    bind, loadCheck, previewResultSchema: renewalStockProtectionPreviewResult,
  })).toBe(0);
  expect(write.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
    { jsonrpc: "2.0", id: 1, error: { code: -32602, message: field
      ? `Invalid arguments for ${name}: ${field} is required. See tools/list.` : "Invalid tool or arguments. See tools/list." } },
    { jsonrpc: "2.0", id: 2, result: {} },
  ]);
  expect(dispatch).toHaveBeenCalledTimes(1);
  expect(loadCheck).toHaveBeenCalledExactlyOnceWith({ app: "./app.ts", configuration: undefined });
  expect(bind).not.toHaveBeenCalled();
});

it.each([
  ["at the top level", "1e400"],
  ["nested in an array", '{"nested":[{"amount":1e400}]}'],
  ["under an own __proto__ member", '{"__proto__":{"amount":1e400}}'],
])("refuses a non-finite preview frame %s before dispatch", async (_, value) => {
  const input = (async function* () {
    yield Buffer.from(`{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"settings_preview","arguments":{"key":"${key}","value":${value}}}}\n`);
    yield Buffer.from('{"jsonrpc":"2.0","id":2,"method":"ping"}\n');
  })();
  const write = vi.fn<(line: string) => void>();
  const bind = vi.fn(async () => ({ previewers: { [key]: async () => validPreview } }));
  expect(await runSettingsCommand(["mcp", "--app=./app.ts", `--database-url=${url}`], { write, input, readStdin: async () => "" }, {
    bind, previewResultSchema: renewalStockProtectionPreviewResult,
  })).toBe(0);
  expect(write.mock.calls.map(([line]) => JSON.parse(line))).toEqual([
    { jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Invalid tool or arguments. See tools/list." } },
    { jsonrpc: "2.0", id: 2, result: {} },
  ]);
  expect(bind).not.toHaveBeenCalled();
});

it("delegates MCP tool calls to host.runTool when supplied", async () => {
  const input = (async function* () {
    yield Buffer.from('{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"settings_list","arguments":{"goal":"renewal"}}}\n');
    yield Buffer.from('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"settings_preview","arguments":{"key":"inventory_renewal_protection","value":{"revision":"x"}}}}\n');
  })();
  const write = vi.fn<(line: string) => void>();
  const delegatedList = document(listSettings({ goal: "renewal" }));
  const delegatedRefusal = document(refuseSettingsPreview("commerce_setting_preview_connection_required"));
  const runTool = vi.fn(async (argv: readonly string[], _stdin: string) => (
    argv[0] === "list"
      ? { exit: 0, stdout: delegatedList }
      : { exit: 1, stdout: delegatedRefusal }
  ));
  expect(await runSettingsCommand(["mcp", "--app=./app.ts"], { write, input, readStdin: async () => "" }, {
    bind: vi.fn(), previewResultSchema: renewalStockProtectionPreviewResult, runTool,
  })).toBe(0);
  expect(runTool).toHaveBeenNthCalledWith(1, ["list", "--json", "--app=./app.ts", "--goal=renewal"], "");
  expect(runTool).toHaveBeenNthCalledWith(2, ["preview", "--json", "--app=./app.ts", "--value=-", "--", "inventory_renewal_protection"], '{"revision":"x"}');
  const replies = write.mock.calls.map(([line]) => JSON.parse(line));
  expect(replies).toEqual([
    { jsonrpc: "2.0", id: 1, result: { isError: false, structuredContent: JSON.parse(delegatedList), content: [{ type: "text", text: delegatedList.trimEnd() }] } },
    { jsonrpc: "2.0", id: 2, result: { isError: true, structuredContent: JSON.parse(delegatedRefusal), content: [{ type: "text", text: delegatedRefusal.trimEnd() }] } },
  ]);
});
