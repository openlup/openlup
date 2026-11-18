import { describe, expect, it, vi } from "vitest";
import { describeRenewalStockProtectionSetting, installRenewalStockProtectionPolicy, readRenewalStockProtectionOverride, readRenewalStockProtectionPolicy, validateRenewalStockProtection } from "../../src/inventory/renewalStockProtection.js";
import { installCheckoutRecoveryReminderSchedule, readCheckoutRecoveryReminderObservation, readCheckoutRecoveryReminderSchedule } from "../../src/commerce/server/checkoutRecoveryReminderSchedule.js";
import { explainSetting, listSettings, settingsReadTools, showSetting } from "../../src/operations/server/settingsRead.js";
import {
  settingsListRequest, settingsListResult, settingsShowRequest, settingsShowResult,
} from "../../src/operations/server/settingsCatalog.js";
import { z } from "zod";

describe("renewal stock policy descriptor", () => {
  it("matches the previous validator's acceptance, normalized value and refusal code", () => {
    const revision = " store-1 ";
    const policy = { revision, renewalProtectionDays: 14 };
    for (const value of [policy, Object.assign(Object.create(null), policy), Object.assign(new (class Policy {})(), policy),
      Object.assign(Object.create({ inherited: true }), policy),
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
    for (const { value, ...example } of describeRenewalStockProtectionSetting().examples) {
      if ("code" in example) expect(() => validateRenewalStockProtection(value)).toThrow(example.code);
      else expect(validateRenewalStockProtection(value)).toStrictEqual(value);
    }
  });
});

it("isolates inventory and reminder reads and installs from mutated discovery data", async () => {
  const inventory = describeRenewalStockProtectionSetting();
  Object.assign(inventory, { key: "different" });
  inventory.fallback.renewalProtectionDays = 99;
  const query = vi.fn(async () => ({ rows: [] }));
  const reminderObservation = await readCheckoutRecoveryReminderObservation({ query });
  if (reminderObservation.present) throw new Error("Expected an absent schedule");
  reminderObservation.effective.abandonedCart[0]!.afterHours = 66;
  const inventoryDefault = { revision: "default", renewalProtectionDays: 14 };
  const reminderDefault = {
    revision: "default",
    abandonedCart: [{ stage: "first", afterHours: 1 }, { stage: "gentle", afterHours: 24 }, { stage: "last", afterHours: 72 }],
    checkoutRecovery: [{ stage: "first", afterHours: 1 }, { stage: "last", afterHours: 20 }],
  } as const;
  expect(await readRenewalStockProtectionPolicy({ query })).toEqual(inventoryDefault);
  expect(await readCheckoutRecoveryReminderSchedule({ query })).toEqual(reminderDefault);
  await installRenewalStockProtectionPolicy({ query }, inventoryDefault);
  await installCheckoutRecoveryReminderSchedule({ query }, reminderDefault);
  expect(query.mock.calls).toEqual([
    [expect.stringMatching(/^SELECT /u), ["checkout_recovery_reminders"]],
    [expect.stringMatching(/^SELECT /u), ["inventory_renewal_protection"]],
    [expect.stringMatching(/^SELECT /u), ["checkout_recovery_reminders"]],
    [expect.stringMatching(/^INSERT /u), ["inventory_renewal_protection", JSON.stringify(inventoryDefault)]],
    [expect.stringMatching(/^INSERT /u), ["checkout_recovery_reminders", JSON.stringify(reminderDefault)]],
  ]);
});

it("shows the effective winback send gate and explains both inventory refusal fields", async () => {
  expect(await showSetting({ key: "subscriber_winback_policy" })).toMatchObject({
    setting: { fallback: { minCancellationAgeDays: 14, maxCancellationAgeDays: 120, requireRetentionConsent: true } },
  });
  const code = "inventory_renewal_protection_policy_invalid";
  expect(explainSetting(code)).toMatchObject({
    explanation: { code, path: [], rule: expect.stringMatching(/revision.*nonblank.*renewalProtectionDays.*1 through 3660/u) },
  });
});

describe("settings show", () => {
  const key = "checkout_recovery_reminders";
  const abandonedCart = [{ stage: "first", afterHours: 1 }, { stage: "gentle", afterHours: 24 }, { stage: "last", afterHours: 72 }];
  it("reports absent reminders with the supplied host offsets and fixed cart waves", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const checkoutRecovery = [{ stage: "first", afterHours: 2 }, { stage: "last", afterHours: 15 }];
    expect(await showSetting({ key }, {
      [key]: () => readCheckoutRecoveryReminderObservation({ query }, { firstOffsetSeconds: 7200, finalOffsetSeconds: 54000 }),
    })).toMatchObject({ observation: { state: "absent", source: "host call parameters, with SQL defaults for omitted offsets",
      value: { abandonedCart, checkoutRecovery } } });
    expect(query).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^SELECT /u), [key]);
  });

  it.each([
    [{ finalOffsetSeconds: 54000 }, 1, 15],
    [{ firstOffsetSeconds: 7200 }, 2, 20],
    [{}, 1, 20],
  ] as const)("uses SQL defaults for omitted host offsets in %j", async (policy, first, last) => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(await showSetting({ key }, {
      [key]: () => readCheckoutRecoveryReminderObservation({ query }, policy),
    })).toMatchObject({ observation: {
      state: "absent", source: "host call parameters, with SQL defaults for omitted offsets",
      value: { abandonedCart, checkoutRecovery: [{ stage: "first", afterHours: first }, { stage: "last", afterHours: last }] },
    } });
  });

  it("reports absent reminders without guessing unknown host offsets and retains cart waves", async () => {
    const result = {
      state: "absent", absentMeans: expect.stringContaining("host call parameters"), source: "host call parameters, with SQL defaults for omitted offsets",
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
  for (const [tool, request] of [
    [list, settingsListRequest], [show, settingsShowRequest],
  ] as const) {
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(tool.inputSchema).toEqual(z.toJSONSchema(request, { target: "draft-07", io: "input", reused: "inline" }));
  }
  const key = "inventory_renewal_protection";
  expect(show.inputSchema).toMatchObject({ properties: { key: { enum: expect.arrayContaining([key]) } } });
  expect(settingsListResult.parse(listSettings({ goal: "inventory buffer" })).entries.map(entry => entry.key)).toEqual([key]);
  expect(settingsShowResult.parse(await showSetting({ key })).setting.schema).toMatchObject({
    properties: { renewalProtectionDays: { minimum: 1, maximum: 3660 } },
  });
  expect(await showSetting({ key: "unknown" })).toEqual({ refusal: expect.objectContaining({
    code: "commerce_setting_unknown", path: ["key"], rule: expect.any(String), hint: expect.any(String),
    remediation: expect.objectContaining({ command: "node --experimental-strip-types host/settings.ts list", retry: true }),
  }) });
});
