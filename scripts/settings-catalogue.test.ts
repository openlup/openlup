import { ListToolsResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { settingsReadTools } from "@openlup/platform/operations/server";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { checkSettingsCatalogue, parseSettingData, renderSettingsCatalogue, settingDescriptors } from "./settings-catalogue.ts";

it("reproduces all three committed settings carriers byte for byte", () => {
  expect(Object.keys(renderSettingsCatalogue())).toHaveLength(3);
  expect(() => checkSettingsCatalogue(process.cwd())).not.toThrow();
});

it("has a domain descriptor for every catalogue entry and covers installed and E/U/K keys", () => {
  const { entries } = JSON.parse(readFileSync("packages/platform/settings-catalog.json", "utf8"));
  const installedKeys = ["inventory_renewal_protection", "checkout_recovery_reminders", "subscriber_winback_policy"].sort();
  expect(entries.map(({ key }) => key)).toEqual(settingDescriptors.map(({ key }) => key).sort());
  expect(entries.filter(({ kind }) => kind === "installed").map(({ key }) => key).sort()).toEqual(installedKeys);
  expect(new Set(entries.map(({ key }) => key)).size).toBe(55);
  expect(entries.filter(({ kind }) => kind === "cap")).toHaveLength(43);
  expect(entries.filter(({ kind }) => kind === "invariant")).toHaveLength(7);
});

it("advertises settings results that the pinned MCP SDK accepts", () => {
  expect(ListToolsResultSchema.parse({ tools: settingsReadTools }).tools).toHaveLength(2);
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
