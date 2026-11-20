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
  ["unknown option", ["list", "--foo"]],
  ["missing flag value", ["list", "--goal"]],
  ["ambiguous value", ["preview", key, "--value", "-1"]],
  ["boolean with value", ["list", "--help=true"]],
  ["misplaced flag", ["show", key, "--sku", "A"]],
  ["unexpected positional", ["list", "foo"]],
  ["unknown command", ["other", key]],
  ["absent command", []],
] as const)("rejects %s as usage", async (_, argv) => {
  const { exit, output } = await run([...argv, "--json"]);
  expect(exit).toBe(64);
  expect(output).toBe(document(invalidSettingsCommand()));
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
  [["{}"], "input_invalid", [], 64],
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

it("uses the connected reader without an app, and names --app for an absent binding", async () => {
  const readers = { [key]: async () => ({ present: false as const }) };
  const host = { bind: vi.fn(async () => ({ readers })) };
  const { exit, output } = await run(["show", key, "--database-url", url, "--json"], { host });
  expect(exit).toBe(0);
  expect(output).toBe(document(await showSetting({ key }, readers)));
  for (const args of [["show", "checkout_recovery_reminders"], ["preview", key, "--value", "{}"]]) {
    const result = await run([...args, "--database-url", url, "--json"], { host });
    expect(result.exit).toBe(1);
    expect(JSON.parse(result.output).refusal.hint).toContain("--app");
  }
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

it("returns configuration choices from the app", async () => {
  const host = { bind: vi.fn(async () => ({ configurationIds: ["coffee", "supplements"] })) };
  const { exit, output } = await run(["preview", key, "--value", "{}", "--app", "./app.ts", "--configuration", "unknown-store", "--json"], { host });
  expect(exit).toBe(64);
  expect(JSON.parse(output).refusal).toMatchObject({
    code: refusalPrefix + "configuration_unknown", hint: expect.stringContaining("coffee, supplements"),
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

it("advertises --value and the exit codes", async () => {
  const { exit, output } = await run(["--help"]);
  expect(exit).toBe(0);
  expect(output).toContain("--value -");
  expect(output).toMatch(/0 completed.*1 refused.*64 invalid syntax or input.*74 operation unavailable/u);
});
