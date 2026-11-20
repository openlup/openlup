import { expect, it, vi } from "vitest";
import { runSettingsCommand } from "../../src/operations/server/settingsCommand.js";
import { explainSetting, invalidSettingsCommand, listSettings, previewSetting, refuseSettingsPreview, showSetting } from "../../src/operations/server/settingsRead.js";

const key = "inventory_renewal_protection";
const url = "postgresql://db.example/shop";
const asOf = new Date(0).toISOString();
const refusalPrefix = "commerce_setting_preview_";

async function run(
  argv: string[],
  options: { stdin?: string; host?: Parameters<typeof runSettingsCommand>[2] } = {},
) {
  const write = vi.fn<(line: string) => void>();
  const readStdin = vi.fn(async () => options.stdin ?? "");
  const exit = await runSettingsCommand(argv, { write, readStdin }, options.host);
  expect(write).toHaveBeenCalledTimes(1);
  const output = write.mock.calls[0]![0];
  return { exit, output, readStdin };
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

it.each(["postgrest://sample@example.test/shop", "https://example.test/shop", "postgresql:///shop", "", "postgres://["])(
  "validates the database URL for show and preview before binding: %j", async databaseUrl => {
    const bind = vi.fn();
    for (const command of [["show", key], ["preview", key, "--value", "{}"]]) {
      const { exit, output } = await run([...command, "--database-url", databaseUrl, "--json"], { host: { bind } });
      expect(exit).toBe(64);
      // Connected show deliberately validates URLs before importing the binding.
      expect(JSON.parse(output).refusal).toMatchObject({ path: ["database-url"], code: command[0] === "show"
        ? "commerce_setting_read_input_invalid" : refusalPrefix + "input_invalid" });
    }
    expect(bind).not.toHaveBeenCalled();
  },
);

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
  expect(bind).toHaveBeenCalledExactlyOnceWith({ databaseUrl: url, app: "./app.mjs", configuration: "sample" });
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
  ["empty result", ["list", "--goal", "no-such-setting"], "No settings matched the goal."],
  ["list result", ["list", "--goal", "inventory buffer"], "inventory_renewal_protection (installed, preview)"],
  ["compact list reason", ["list", "--goal", "shipping.addressRegions"],
    "\n  The native address contract requires a postal code and has no region field.\n  Change: docs/guide/"],
  ["text refusal", ["show", "unknown"], "commerce_setting_unknown"],
  ["text explanation", ["explain", "commerce_setting_unknown"], "commerce_setting_unknown"],
  ["text provenance", ["show", key], "Basis: reference-code (matches the reference deployment’s code)"],
  ["text neutral basis", ["show", "offer.freeShippingFromMinor"], "Basis: neutral\n"],
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
  ["offer.freeShippingFromMinor", undefined, false, 0, undefined],
] as const)("shows %s with database URL and app %s", async (setting, app, hasReader, expectedExit, hint) => {
  const readers = hasReader ? { [setting]: async () => ({ present: false as const }) } : {};
  const bind = vi.fn(async () => ({ readers }));
  const { exit, output } = await run(["show", setting, "--database-url", url, "--json", ...(app ? ["--app", app] : [])], { host: { bind } });
  expect(exit).toBe(expectedExit);
  if (hint) expect(JSON.parse(output)).toMatchObject({
    refusal: { code: "commerce_setting_read_unavailable", path: ["key"], hint },
  });
  else expect(output).toBe(document(await showSetting({ key: setting }, readers)));
  // A connected request only needs a binding for a known installed key.
  expect(bind).toHaveBeenCalledTimes(setting === "offer.freeShippingFromMinor" || setting === "unknown" ? 0 : 1);
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

it.each([
  [["preview", "--value", "{}"], ["key"], "Pass the setting key and one proposed JSON value with --value."],
  [["preview", key, "--value", "{}", "--goal", "stock"], ["goal"], "Use --goal with list."],
  [["preview", key, "--value", "{}", "--database-url="], ["database-url"], "Supply a read-capable database URL."],
  [["preview", "--database-url="], ["database-url"], "Supply a read-capable database URL."],
  [["preview", key, "--value", "{}", "--database-url", "postgresql:///shop"], ["database-url"], "Supply a PostgreSQL URL for the intended store."],
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
  expect(host.bind).toHaveBeenCalledExactlyOnceWith({ databaseUrl: url, app, configuration: undefined });
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
  expect(host.bind).toHaveBeenCalledExactlyOnceWith({ databaseUrl: flags.some(flag => flag === url) ? url : undefined, app: "./app.ts", configuration });
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
  if (bindCalled) expect(host.bind).toHaveBeenCalledExactlyOnceWith({ databaseUrl: undefined, app: "./app.ts", configuration: "coffee" });
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
  [["check"], "app"], [[...checkArgs, "--database-url", url], "database-url"],
  [[...checkArgs, "--database-url="], "database-url"], [[...checkArgs, "--value", "{}"], "value"],
  [[...checkArgs, "--sku", "A"], "sku"], [[...checkArgs, "--as-of", asOf], "as-of"],
  [[...checkArgs, "--goal", "stock"], "goal"], [[...checkArgs, key], "key"],
  [[...checkArgs, "--unknown"], "unknown"], [[...checkArgs, "--app"], "app"],
] as const)("refuses invalid check arguments %j without a load", async (args, field) => {
  const load = vi.fn();
  const { exit, output } = await run([...args, "--json"], { host: checks(load) });
  expect(exit).toBe(64);
  expect(JSON.parse(output).refusal.path).toEqual([field]);
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
  const { exit, output } = await run(checkArgs, { host: checks(async () => ({
    file: { ...minimumFile, entries: { [key]: { value: JSON.parse(raw) } } },
  })) });
  expect(exit).toBe(1);
  expect(output).toContain(`"file":{"state":"present","value":${raw}},"validation":{"state":"invalid","paths":${JSON.stringify([path])}}`);
});

const discountKey = "offer.subscriptionDiscountBps";
const catalogueReference = { catalogueReference: { file: "owned/store.config.ts", symbol: discountKey } };
it.each([
  [{ file: "policy.ts", symbol: "discount", line: 42 }, { location: { file: "policy.ts", symbol: "discount" } }],
  [{ file: "policy.ts" }, catalogueReference],
  [{ file: 42, symbol: "discount" }, catalogueReference],
] as const)("projects a binding location %j and ignores non-catalogue keys", async (raw, source) => {
  const host = checks(async () => ({ file: { ...minimumFile, entries: {
    [discountKey]: { value: 500, location: raw as { file: string; symbol: string } }, typo: { value: 1n },
  } } }));
  const { exit, output } = await run(checkArgs, { host });
  expect(exit).toBe(0);
  const row = JSON.parse(output).rows.find((item: { key: string }) => item.key === discountKey);
  expect(row).toMatchObject({
    file: { state: "present", ...source, value: 500 }, validation: { state: "valid" },
    effect: "The starter uses the deployed discount in subscription estimates. Initial installation seeds the native price policy from this value.",
    takesEffect: "owned/store.config.ts offer.subscriptionDiscountBps",
  });
  expect(output).not.toContain('"key":"typo"');
  const text = await run(checkArgs.filter(arg => arg !== "--json"), { host });
  expect(text.output).toContain("Initial installation seeds the native price policy from this value.");
  if ("catalogueReference" in source) expect(text.output).toContain("Starter catalogue reference — owned/store.config.ts");
});

it("checks every packaged schema against its default and valid examples", async () => {
  const { loadSettingsCatalogue } = await import("../../src/operations/server/settingsCatalog.js");
  const entries = loadSettingsCatalogue().entries.filter(entry => "fallback" in entry).filter(entry =>
    (entry.kind === "code" || entry.kind === "installed") && entry.schema);
  expect(entries).toHaveLength(7);
  for (const entry of entries) {
    for (const value of [entry.fallback, ...entry.examples.filter(example => !example.code).map(example => example.value)]) {
      const host = checks(async () => ({ file: { ...minimumFile, entries: { [entry.key]: { value } } } }));
      const { exit, output } = await run(checkArgs, { host });
      expect(exit, entry.key).toBe(0);
      expect(JSON.parse(output).rows.find((row: { key: string }) => row.key === entry.key).validation).toEqual({ state: "valid" });
    }
  }
});
