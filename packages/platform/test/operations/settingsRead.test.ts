import { describe, expect, it, vi } from "vitest";
import { readRenewalStockProtectionOverride, renewalStockProtectionSetting, validateRenewalStockProtection } from "../../src/inventory/renewalStockProtection.js";
import { readCheckoutRecoveryReminderOverride } from "../../src/commerce/server/checkoutRecoveryReminderSchedule.js";
import { explainSetting, listSettings, settingsReadTools, showSetting } from "../../src/operations/server/settingsRead.js";
import {
  settingsListRequest, settingsListResult, settingsRefusalResult, settingsShowRequest, settingsShowResult,
} from "../../src/operations/server/settingsCatalog.js";
import { toolInputSchema } from "../../src/operations/index.js";
import { z } from "zod";

describe("renewal stock policy descriptor", () => {
  it("matches the previous validator's acceptance, normalized value and refusal code", () => {
    const revision = " store-1 ";
    const policy = { revision, renewalProtectionDays: 14 };
    for (const value of [policy, Object.assign(Object.create(null), policy), Object.assign(new (class Policy {})(), policy),
      { ...policy, renewalProtectionDays: 1 }, { ...policy, renewalProtectionDays: 3660 }]) {
      expect(validateRenewalStockProtection(value)).toStrictEqual({
        revision: value.revision, renewalProtectionDays: value.renewalProtectionDays,
      });
    }
    for (const value of [null, [], false, {}, { revision }, { renewalProtectionDays: 14 },
      { ...policy, extra: true }, Object.create(policy),
      ...[0, 3661, 1.5, "14", null, NaN, Infinity].map(renewalProtectionDays => ({ revision, renewalProtectionDays })),
      ...["", " \t\n", "\u00a0", null, 1].map(invalidRevision => ({ ...policy, revision: invalidRevision }))]) {
      expect(() => validateRenewalStockProtection(value)).toThrow("inventory_renewal_protection_policy_invalid");
    }
    for (const { value, ...example } of renewalStockProtectionSetting.examples) {
      if ("code" in example) expect(() => validateRenewalStockProtection(value)).toThrow(example.code);
      else expect(validateRenewalStockProtection(value)).toStrictEqual(value);
    }
  });
});

describe("settings show", () => {
  const key = "checkout_recovery_reminders";
  const abandonedCart = [{ stage: "first", afterHours: 1 }, { stage: "gentle", afterHours: 24 }, { stage: "last", afterHours: 72 }];
  it("reports absent reminders with the supplied host offsets and fixed cart waves", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const checkoutRecovery = [{ stage: "first", afterHours: 2 }, { stage: "last", afterHours: 15 }];
    expect(await showSetting({ key }, {
      [key]: async () => {
        expect(await readCheckoutRecoveryReminderOverride({ query })).toBeUndefined();
        return { present: false, effective: { abandonedCart, checkoutRecovery } };
      },
    })).toMatchObject({ observation: { state: "absent", source: "host call parameters",
      value: { abandonedCart, checkoutRecovery } } });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^SELECT /u), [key]);
  });

  it("reports absent reminders without guessing unknown host offsets and retains cart waves", async () => {
    const result = {
      state: "absent", absentMeans: expect.stringContaining("host call parameters"), source: "host call parameters",
      value: { abandonedCart, checkoutRecovery: null },
    };
    expect(await showSetting({ key }, { [key]: async () => ({ present: false }) })).toMatchObject({ observation: result });
    expect(explainSetting(key)).toMatchObject({ observation: result });
  });

  it("distinguishes an equal explicit override, confirmed fallback, and offline inventory discovery", async () => {
    const key = "inventory_renewal_protection";
    const value = { revision: "default", renewalProtectionDays: 14 };
    const db = { query: vi.fn()
      .mockResolvedValueOnce({ rows: [{ value_text: JSON.stringify(value) }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ value_text: "malformed" }] }) };
    const readers = { [key]: async () => {
      const installed = await readRenewalStockProtectionOverride(db);
      return installed ? { present: true, value: { ...installed }, revision: installed.revision } as const : { present: false } as const;
    } };
    expect(await showSetting({ key }, readers)).toMatchObject({ observation: { state: "override", value, revision: value.revision } });
    expect(await showSetting({ key }, readers)).toMatchObject({ observation: { state: "fallback", value } });
    expect(await showSetting({ key })).toMatchObject({ observation: { state: "offline" } });
    expect(await showSetting({ key }, readers)).toMatchObject({ refusal: { code: "commerce_setting_read_unavailable" } });
  });
});

it("projects read-only MCP inputs and results from the settings read contracts", async () => {
  const [list, show] = settingsReadTools;
  expect(settingsReadTools.map(({ name }) => name)).toEqual(["settings__list", "settings__show"]);
  for (const [tool, request, result] of [
    [list, settingsListRequest, settingsListResult], [show, settingsShowRequest, settingsShowResult],
  ] as const) {
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(tool.inputSchema).toEqual(toolInputSchema(request));
    expect(tool.outputSchema).toEqual(toolInputSchema(z.union([result, settingsRefusalResult]), "output"));
  }
  const key = "inventory_renewal_protection";
  expect(show.inputSchema).toMatchObject({ properties: { key: { enum: expect.arrayContaining([key]) } } });
  expect(settingsListResult.parse(listSettings({ goal: "inventory buffer" })).entries.map(entry => entry.key)).toEqual([key]);
  expect(settingsShowResult.parse(await showSetting({ key })).setting.schema).toMatchObject({
    properties: { renewalProtectionDays: { minimum: 1, maximum: 3660 } },
  });
  expect(await showSetting({ key: "unknown" })).toEqual({ refusal: expect.objectContaining({
    code: "commerce_setting_unknown", path: ["key"], rule: expect.any(String), hint: expect.any(String),
    remediation: expect.objectContaining({ command: "npm run settings -- list", retry: true }),
  }) });
});
