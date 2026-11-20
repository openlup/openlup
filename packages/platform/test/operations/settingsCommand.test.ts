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

it.each([
  ["misplaced flag", ["show", key, "--sku", "A"]],
  ["unexpected positional", ["list", "foo"]],
  ["unknown command", ["other", key]],
  ["absent command", []],
] as const)("rejects %s as usage", async (_, argv) => {
  const { exit, output } = await run([...argv, "--json"]);
  expect(exit).toBe(64);
  expect(output).toBe(document(invalidSettingsCommand()));
});

it.each([
  [[], ["--sku"], "sku", "Supply a value for --sku as shown in preview help."],
  [["--app", "./app.ts"], ["--sku", "--json"], "sku", "Supply a value for --sku as shown in preview help."],
  [[], ["--sku-extra=sample"], "sku-extra", "Unknown option --sku-extra. See preview help."],
  [[], ["-x"], "x", "Unknown option -x. See preview help."],
  [[], ["--json=1"], "json", "Supply a value for --json as shown in preview help."],
  [[], ["--value", "-1"], "value", "Supply a value for --value as shown in preview help."],
] as const)("names the offending preview option in %j %j", async (prefix, flags, option, hint) => {
  const { exit, output } = await run([...prefix, "preview", key, "--value", "{}", "--json", ...flags]);
  expect(exit).toBe(64);
  expect(output).toBe(document(refuseSettingsPreview(refusalPrefix + "input_invalid", { path: [option], hint })));
});

it.each([
  [["list", "--foo"], "foo", "Unknown option --foo. See settings help."],
  [["list", "--goal"], "goal", "Supply a value for --goal as shown in settings help."],
] as const)("names the offending settings option in %j", async (argv, option, hint) => {
  const { exit, output } = await run(["--json", ...argv]);
  expect(exit).toBe(64);
  const { refusal } = invalidSettingsCommand();
  expect(output).toBe(document({ refusal: { ...refusal, path: [option], hint } }));
});

it.each(["postgrest://sample@example.test/shop", "https://example.test/shop", "postgresql:///shop", "", "postgres://["])(
  "validates the database URL for show and preview before binding: %j", async databaseUrl => {
    const bind = vi.fn();
    for (const command of [["show", key], ["preview", key, "--value", "{}"]]) {
      const { exit, output } = await run([...command, "--database-url", databaseUrl, "--json"], { host: { bind } });
      expect(exit).toBe(64);
      expect(JSON.parse(output).refusal.code).toBe(command[0] === "show"
        ? "commerce_setting_read_input_invalid" : refusalPrefix + "input_invalid");
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
  [[], "input_invalid", ["proposed"], 64],
  [["{}"], "input_invalid", ["proposed"], 64],
  [["--value", "{"], "json_invalid", ["proposed"], 64],
  [["--value", "{}", "--as-of", "yesterday"], "input_invalid", ["asOf"], 64],
  [["--value", "{}", "--sku", ""], "input_invalid", ["skus"], 64],
  [["--value", "1e999"], "input_invalid", ["proposed"], 64],
  [["--value", "{}"], "connection_required", [], 1],
] as const)("reports preview refusal for %j", async (argv, code, path, status) => {
  const { exit, output } = await run(["preview", key, ...argv, "--json"]);
  expect(exit).toBe(status);
  expect(JSON.parse(output)).toMatchObject({ schemaVersion: 1, refusal: { code: refusalPrefix + code, path } });
});

it("uses the same dispatcher bytes for offline results and refusals", async () => {
  const reminder = "checkout_recovery_reminders";
  const cases = [
    [["list", "--goal", "renewal stock"], listSettings({ goal: "renewal stock" }), 0],
    [["list", "--goal", " "], listSettings({ goal: " " }), 64],
    [["show", reminder], await showSetting({ key: reminder }), 0],
    [["show", "unknown"], await showSetting({ key: "unknown" }), 1],
    [["explain", "commerce_setting_unknown"], explainSetting("commerce_setting_unknown"), 0],
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
  [key, undefined, true, 0, undefined],
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
  expect(bind).toHaveBeenCalledTimes(setting === "offer.freeShippingFromMinor" ? 0 : 1);
});

it("names --app when connected preview lacks a stock binding", async () => {
  const host = { bind: vi.fn(async () => ({})) };
  const { exit, output } = await run(["preview", key, "--value", "{}", "--database-url", url, "--json"], { host });
  expect(exit).toBe(1);
  expect(JSON.parse(output).refusal.hint).toContain("--app");
});

it.each([
  [["preview", "--value", "{}"], ["key"], "Pass the setting key and one proposed JSON value with --value."],
  [["preview", key, "--value", "{}", "--goal", "stock"], ["goal"], "Use --goal with list."],
  [["preview", key, "--value", "{}", "--database-url="], ["database-url"], "Supply a read-capable database URL."],
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

it.each(["unknown-store", ""])("returns configuration choices from the app for %j", async configuration => {
  const host = { bind: vi.fn(async () => ({ configurationIds: ["coffee", "supplements"] })) };
  const { exit, output } = await run(["preview", key, "--value", "{}", "--app", "./app.ts", `--configuration=${configuration}`, "--json"], { host });
  expect(exit).toBe(64);
  expect(JSON.parse(output).refusal).toMatchObject({
    code: refusalPrefix + "configuration_unknown", path: ["configuration"],
    hint: `Unknown configuration ${JSON.stringify(configuration)}. Use one of these IDs: coffee, supplements.`,
  });
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
  expect(JSON.parse(output).refusal.code).toBe("commerce_setting_read_unavailable");
});

it.each([[["--help"]], [["preview", "--help"]]] as const)("labels settings %j experimental and advertises --value and the exit codes", async argv => {
  const { exit, output } = await run([...argv]);
  expect(exit).toBe(0);
  expect(output.split("\n")[0]).toContain("openlup settings (experimental)");
  expect(output).toContain("--value -");
  expect(output).toMatch(/0 completed.*1 refused.*64 invalid syntax or input.*74 operation unavailable/u);
});
