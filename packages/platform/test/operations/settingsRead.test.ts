import { readFileSync } from "node:fs";
import { settingDescriptorSchema, settingRefusalSchema, toolInputSchema } from "../../src/operations/server/toolSchema.js";
import { describe, expect, it, vi } from "vitest";
import { previewRenewalStockProtection, renewalStockProtectionPreviewResult, describeRenewalStockProtectionSetting, installRenewalStockProtectionPolicy, readRenewalStockProtectionOverride, readRenewalStockProtectionPolicy, validateRenewalStockProtection } from "../../src/inventory/renewalStockProtection.js";
import { installCheckoutRecoveryReminderSchedule, readCheckoutRecoveryReminderObservation, readCheckoutRecoveryReminderSchedule } from "../../src/commerce/server/checkoutRecoveryReminderSchedule.js";
import { explainSetting, listSettings, previewSetting, refuseSettingsPreview, settingsPreviewRequest, settingsReadTools, showSetting } from "../../src/operations/server/settingsRead.js";
import { loadSettingsCatalogue, settingsListRequest } from "../../src/operations/server/settingsCatalog.js";
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
  if ("refusal" in reminderObservation || reminderObservation.present) throw new Error("Expected an absent schedule");
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
    ["SELECT public.commerce_install_checkout_recovery_reminder_schedule($1::text, $2::jsonb)",
      ["checkout_recovery_reminders", JSON.stringify(reminderDefault)]],
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
  it("accepts every catalogue descriptor in the show output schema", async () => {
    const { entries, showResult } = loadSettingsCatalogue();
    for (const setting of entries) {
      const expected = { schemaVersion: 1, setting, observation: { state: "offline" } };
      expect(showResult.parse(expected), setting.key).toEqual(expected);
      expect(await showSetting({ key: setting.key }), setting.key).toEqual(expected);
    }
  });

  it("rejects the same unsupported descriptor version as the catalogue schema", () => {
    const { entries, showResult } = loadSettingsCatalogue();
    const value = entries.find(entry => entry.kind === "code");
    if (!value) throw new Error("Expected a code descriptor");
    const setting = { ...value, schemaVersion: 2 };
    expect(settingDescriptorSchema.safeParse(setting).success).toBe(false);
    expect(showResult.safeParse({ schemaVersion: 1, setting, observation: { state: "offline" } }).success).toBe(false);
  });

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
    [{ finalOffsetSeconds: 86400, checkoutSeconds: 86401 }, 1, 24],
  ] as const)("uses SQL defaults for omitted host offsets in %j", async (policy, first, last) => {
    const query = vi.fn(async () => ({ rows: [] }));
    expect(await showSetting({ key }, {
      [key]: () => readCheckoutRecoveryReminderObservation({ query }, policy),
    })).toMatchObject({ observation: {
      state: "absent", source: "host call parameters, with SQL defaults for omitted offsets",
      value: { abandonedCart, checkoutRecovery: [{ stage: "first", afterHours: first }, { stage: "last", afterHours: last }] },
    } });
  });

  it.each([
    { firstOffsetSeconds: 72000 },
    { finalOffsetSeconds: 86400 },
    { recoverySeconds: 2147483648 },
    { activitySeconds: 0.5 },
    { profile: "capture!" },
    { profile: "capture", unknown: true },
  ])("refuses a host policy rejected by the native validator: %j", async policy => {
    const query = vi.fn(async () => ({ rows: [] }));
    const code = "checkout_recovery_policy_invalid";
    const explanation = explainSetting(code);
    expect(explanation).toMatchObject({
      explanation: { code, remediation: { retry: true, action: expect.stringContaining("Correct the supplied policy") } },
    });
    const result = await showSetting({ key }, {
      [key]: () => readCheckoutRecoveryReminderObservation({ query }, policy),
    });
    expect(result).toEqual({ refusal: "explanation" in explanation && explanation.explanation });
  });

  it("reports absent reminders without guessing unknown host offsets and retains cart waves", async () => {
    const result = {
      state: "absent", absentMeans: expect.stringContaining("host call parameters"), source: "host call parameters, with SQL defaults for omitted offsets",
      value: { abandonedCart, checkoutRecovery: null },
    };
    const db = { query: async () => ({ rows: [] }) };
    expect(await showSetting({ key }, { [key]: () => readCheckoutRecoveryReminderObservation(db) })).toMatchObject({ observation: result });
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

it.each([
  ["inventory buffer", "inventory_renewal_protection"],
  ["free shipping", "offer.freeShippingFromMinor"],
  ["subscription discount", "offer.subscriptionDiscountBps"],
  ["delivery interval", "subscriptionOffers.deliveryCycles"],
  ["checkout reservation", "purchase.reservationMinutes"],
])("finds %s in the settings list", (goal, key) => {
  const { listResult } = loadSettingsCatalogue();
  const entries = listResult.parse(listSettings({ goal })).entries;
  expect(entries[0]?.key).toBe(key);
});

it("projects read-only MCP inputs and results from the settings read contracts", async () => {
  const [list, show, preview] = settingsReadTools;
  const { showRequest, showResult } = loadSettingsCatalogue();
  expect(settingsReadTools.map(({ name }) => name)).toEqual(["settings__list", "settings__show", "settings__preview"]);
  for (const [tool, request] of [
    [list, settingsListRequest], [show, showRequest], [preview, settingsPreviewRequest],
  ] as const) {
    const { inputSchema, outputSchema } = tool;
    expect(tool.inputSchema).toBe(inputSchema);
    expect(tool.outputSchema).toBe(outputSchema);
    expect(tool.annotations).toEqual({ readOnlyHint: true });
    expect(tool.inputSchema).toEqual(z.toJSONSchema(request, { target: "draft-07", io: "input", reused: "inline" }));
  }
  const { byCode } = loadSettingsCatalogue();
  expect(preview.outputSchema).toEqual({
    type: "object",
    ...toolInputSchema(z.union([renewalStockProtectionPreviewResult, z.strictObject({
      schemaVersion: z.literal(1), refusal: settingRefusalSchema([...byCode.keys()]),
    })]), "output"),
  });
  const key = "inventory_renewal_protection";
  expect(show.inputSchema).toMatchObject({ properties: { key: { enum: expect.arrayContaining([key]) } } });
  expect(showResult.parse(await showSetting({ key })).setting).toHaveProperty("schema.properties.renewalProtectionDays", expect.objectContaining({ minimum: 1, maximum: 3660 }));
  expect(await showSetting({ key: "unknown" })).toEqual({ refusal: expect.objectContaining({
    code: "commerce_setting_unknown", path: ["key"], rule: expect.any(String), hint: expect.any(String),
    remediation: expect.objectContaining({ command: "npm --silent run settings -- list", retry: true }),
  }) });
});

const previewKey = "inventory_renewal_protection";
const asOf = new Date(0).toISOString();
const proposed = { revision: "candidate", renewalProtectionDays: 21 };

it.each([
  ["SELECT value_text", "42501", "policy_read_denied", /read the installed policy/u],
  ["inventory_new_purchase_stock_read(", "42501", "stock_read_denied", /read stock availability/u],
  ["inventory_renewal_protection_validate(", "42501", "validation_denied", /permission to preview/u],
  ["inventory_renewal_protection_validate(", "42883", "validation_missing", /update the store/u],
  ["inventory_new_purchase_stock_preview(", "42883", "validation_missing", /update the store/u,
    "Apply the database forward 20261123152000_inventory_new_purchase_stock_preview.sql, then retry."],
  ["ROLLBACK", "other", "unexpected", /Retry once/u],
] as const)("returns the same contextual refusal from domain and dispatcher when %s fails", async (operation, code, reason, action, hint?) => {
  const release = vi.fn();
  const query = vi.fn(async (statement: string) => {
    if (statement.includes(operation)) throw { code, message: "private details" };
    if (statement.includes("inventory_renewal_protection_validate(")) return { rows: [{ value: proposed }] };
    if (statement.includes("inventory_new_purchase_stock_read(")) return { rows: [{ response: [] }] };
    return { rows: [] };
  });
  const connection = { sourceKey: "fixture", db: { connect: async () => ({ query, release }) } };
  const request = { key: previewKey, proposed, skus: ["fixture"], asOf };
  const direct = await previewRenewalStockProtection(previewKey, proposed, {
    ...connection, asOf, skus: request.skus, refuse: refuseSettingsPreview,
  });
  expect(direct).toMatchObject({ schemaVersion: 1, refusal: {
    code: `commerce_setting_preview_${reason}`,
    ...(hint ? { path: ["proposed"], hint } : {}),
    remediation: { action: expect.stringMatching(action), command: expect.stringContaining("<read-capable-url>") },
  } });
  expect(JSON.stringify(direct)).not.toMatch(/private details|public[.]/u);
  expect(await previewSetting(request, {
    [previewKey]: (value, options) => previewRenewalStockProtection(previewKey, value, { ...connection, ...options }),
  })).toEqual(direct);
  expect(query).toHaveBeenLastCalledWith("ROLLBACK");
  expect(release).toHaveBeenCalledWith(operation === "ROLLBACK");
});

it.each([true, false])("rejects when only one validator admits the proposal (installer admits %s)", async installerAdmits => {
  const value = { ...proposed, renewalProtectionDays: installerAdmits ? 21 : 0 };
  const query = vi.fn(async (statement: string) => {
    if (!statement.includes("inventory_renewal_protection_validate(")) return { rows: [] };
    if (installerAdmits) throw { code: "22023" };
    return { rows: [{ value: proposed }] };
  });
  const result = await previewRenewalStockProtection(previewKey, value, {
    asOf, skus: [], refuse: refuseSettingsPreview, sourceKey: "fixture",
    db: { connect: async () => ({ query, release() {} }) },
  });
  const code = "inventory_renewal_protection_policy_invalid";
  const { rule, hint, remediation } = refuseSettingsPreview(code).refusal;
  expect(result).toMatchObject({
    proposed: value, difference: null, validation: { state: "invalid", code, rule, hint, remediation },
    effect: { newPurchaseAvailability: "undetermined" },
  });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("inventory_renewal_protection_validate("), [JSON.stringify(value)]);
});

it("snapshots a direct proposal before connecting and admits a request with more than 200 SKUs", async () => {
  const value = { ...proposed };
  const query = vi.fn(async (statement: string) => ({
    rows: statement.includes("inventory_renewal_protection_validate(") ? [{ value: proposed }] : [],
  }));
  const result = await previewRenewalStockProtection(previewKey, value, {
    asOf, skus: [], refuse: refuseSettingsPreview, sourceKey: "fixture",
    db: { connect: async () => {
      value.renewalProtectionDays = 0;
      return { query, release() {} };
    } },
  });
  expect(result).toMatchObject({ proposed, validation: { state: "valid", value: proposed } });
  expect(query).toHaveBeenCalledWith(expect.stringContaining("inventory_renewal_protection_validate("), [JSON.stringify(proposed)]);
  const skus = Array.from({ length: 201 }, (_, index) => `SKU-${index}`);
  await expect(previewSetting({ key: previewKey, proposed, skus }, { [previewKey]: async (_, input) => {
    expect(input.skus).toEqual(skus);
    return { schemaVersion: 1 };
  } })).resolves.toEqual({ schemaVersion: 1 });
});

it("refuses nonfinite numbers under own __proto__ keys at the root or nested", async () => {
  const run = vi.fn(async () => ({ schemaVersion: 1 as const }));
  for (const json of [
    '{"revision":"x","renewalProtectionDays":14,"__proto__":1e400}',
    '{"revision":"x","renewalProtectionDays":14,"__proto__":[{"__proto__":-1e400}]}',
  ]) {
    await expect(previewSetting({ key: previewKey, proposed: JSON.parse(json) }, { [previewKey]: run }))
      .resolves.toMatchObject({ schemaVersion: 1, refusal: {
        code: "commerce_setting_preview_input_invalid", path: ["proposed"],
        hint: "Supply a decoded JSON value with finite numbers.",
      } });
  }
  expect(run).not.toHaveBeenCalled();
});

it("passes exact SKU identifiers through and deduplicates only exact matches", async () => {
  const skus = ["SKU-1", " SKU-1 ", "SKU-1", " SKU-1 "];
  const run = vi.fn(async () => ({ schemaVersion: 1 as const }));
  await expect(previewSetting({ key: previewKey, proposed, skus, asOf }, { [previewKey]: run }))
    .resolves.toEqual({ schemaVersion: 1 });
  expect(run).toHaveBeenCalledExactlyOnceWith(proposed, expect.objectContaining({ skus: ["SKU-1", " SKU-1 "] }));
});

it("matches the pinned serialized schemas of the list and show settings tools", () => {
  const expected = readFileSync(new URL("./settingsReadToolSchemas.main.json", import.meta.url), "utf8");
  const schemas = settingsReadTools
    .filter(({ name }) => name === "settings__list" || name === "settings__show")
    .map(({ name, inputSchema, outputSchema }) => ({ name, inputSchema, outputSchema }));
  expect(JSON.stringify(schemas) + "\n").toBe(expected);
});
