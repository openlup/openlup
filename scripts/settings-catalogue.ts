import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ZodType } from "zod";
import { toolInputSchema } from "@openlup/platform/operations";
import type { SettingDescriptor, SettingRefusal } from "@openlup/platform/operations/contracts";
import { renewalStockProtectionSetting, inventorySettingBoundaries } from "@openlup/platform/inventory";
import { checkoutRecoveryReminderSetting, commerceSettingBoundaries } from "@openlup/platform/commerce";
import { subscriptionSettings, subscriptionsSettingBoundaries } from "@openlup/platform/subscriptions";
import { savedAddressValidationSetting, shippingSettingBoundaries } from "@openlup/platform/shipping";
import { account_supportSettingBoundaries } from "@openlup/platform/account-support";
import { catalogSettingBoundaries } from "@openlup/platform/catalog";
import { communicationsSettingBoundaries } from "@openlup/platform/communications";
import { fulfillmentSettingBoundaries } from "@openlup/platform/fulfillment";
import { identitySettingBoundaries } from "@openlup/platform/identity";
import { invoicingSettingBoundaries } from "@openlup/platform/invoicing";
import { paymentsSettingBoundaries } from "@openlup/platform/payments";
import { pricingSettingBoundaries } from "@openlup/platform/pricing";
import { promotionsSettingBoundaries } from "@openlup/platform/promotions";

type SourceDescriptor = Omit<SettingDescriptor, "schema" | "previewSchema"> & {
  schema?: ZodType | SettingDescriptor["schema"];
  previewSchema?: ZodType | SettingDescriptor["previewSchema"];
};

function informationalSettings(
  domain: string,
  rows: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[],
): SettingDescriptor[] {
  return rows.map(([key, kind, goal, reason]) => ({
    key: `${domain}.${key}`, domain, goal, schemaVersion: 1, kind,
    rules: [], examples: [], fallback: null,
    defaultBasis: { kind: "neutral" },
    whyThisDefault: reason,
    effect: { appliesTo: reason, frozenOn: [], impact: "operations" },
    runtime: { level: "read-only", reason },
    change: { reference: "docs/guide/how-to/operate/settings-catalogue.md#" + `${domain}${key}`.toLowerCase() },
  }));
}

export const settingDescriptors = [
  renewalStockProtectionSetting, checkoutRecoveryReminderSetting,
  ...subscriptionSettings, savedAddressValidationSetting,
  ...informationalSettings("inventory", inventorySettingBoundaries),
  ...informationalSettings("commerce", commerceSettingBoundaries),
  ...informationalSettings("subscriptions", subscriptionsSettingBoundaries),
  ...informationalSettings("shipping", shippingSettingBoundaries),
  ...informationalSettings("account-support", account_supportSettingBoundaries),
  ...informationalSettings("catalog", catalogSettingBoundaries),
  ...informationalSettings("communications", communicationsSettingBoundaries),
  ...informationalSettings("fulfillment", fulfillmentSettingBoundaries),
  ...informationalSettings("identity", identitySettingBoundaries),
  ...informationalSettings("invoicing", invoicingSettingBoundaries),
  ...informationalSettings("payments", paymentsSettingBoundaries),
  ...informationalSettings("pricing", pricingSettingBoundaries),
  ...informationalSettings("promotions", promotionsSettingBoundaries),
] satisfies readonly SourceDescriptor[];

function settingCommand(key: string): string {
  return `npm run settings -- show ${key}`;
}

function isZod(schema: ZodType | Record<string, unknown>): schema is ZodType {
  return typeof schema.safeParse === "function";
}

function describeSetting(entry: SourceDescriptor) {
  const { schema, previewSchema, rules, ...metadata } = entry;
  return {
    ...metadata,
    schema: schema ? (isZod(schema) ? toolInputSchema(schema) : schema) : null,
    previewSchema: previewSchema ? (isZod(previewSchema) ? toolInputSchema(previewSchema, "output") : previewSchema) : null,
    rules: rules.map(({ code, path, description }) => ({ code, path, description })),
  };
}

const searchTerms: Record<string, string> = {
  inventory_renewal_protection: "stock lookahead, inventory buffer, renewal allocation, available to promise",
  checkout_recovery_reminders: "abandoned basket, reminder cadence, payment follow-up, recovery offsets",
  subscriber_winback_policy: "cancelled subscriber outreach, retention messaging, reactivation window",
  "subscriptionCreation.editWindowHours": "edit cutoff, change deadline, activation window",
  savedAddressValidation: "postal format, phone normalization, delivery address checks",
  "account-support": "operator permissions, administrative access",
  catalog: "product assortment, SKU records",
  commerce: "store orders, checkout processing",
  communications: "messaging, notifications",
  fulfillment: "shipping, dispatch, delivery",
  identity: "account access, sign-in",
  inventory: "stock, allocation, availability",
  invoicing: "billing documents, adjustments",
  payments: "charge handling, settlement",
  pricing: "quote amounts, price calculation",
  promotions: "discount rules, offer adjustments",
  shipping: "delivery destination, address details",
  subscriptions: "recurring orders, renewals",
};

function settingSynonyms(entry: { key: string; domain: string }): string {
  return searchTerms[entry.key] ?? searchTerms[entry.domain] ?? "";
}

export const settingsCatalogue = [...settingDescriptors]
  .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
  .map(describeSetting);
if (new Set(settingsCatalogue.map(entry => entry.key)).size !== settingsCatalogue.length) throw new Error("Duplicate setting key");

const settingRefusals: readonly SettingRefusal[] = [
  {
    code: "commerce_setting_unknown",
    path: ["key"],
    rule: "Use a key from the installed settings catalogue.",
    hint: "Search by the business goal to find the key.",
    remediation: { retry: true, action: "Find a key in the list, then run show with that key.", command: "npm run settings -- list" },
  },
  {
    code: "commerce_setting_refusal_unknown",
    path: ["code"],
    rule: "Use a refusal code from this package version.",
    hint: "Copy the exact code from the refusal.",
    remediation: { retry: true, action: "Use explain with the reported code.", command: "npm run settings -- explain commerce_setting_unknown" },
  },
  {
    code: "commerce_setting_read_input_invalid",
    path: [],
    rule: "Supply a supported settings command and its required arguments.",
    hint: "Each settings command has an example in help.",
    remediation: { retry: true, action: "Review command syntax and correct the arguments.", command: "npm run settings -- --help" },
  },
  {
    code: "commerce_setting_read_unavailable",
    path: ["key"],
    rule: "A connected read requires an accessible, valid settings row or confirmed absence.",
    hint: "Read with an authorized settings reader for the intended store.",
    remediation: { retry: true, action: "Check the connection and SELECT access, or omit the connection to use discovery offline.", command: "npm run settings -- list" },
  },
  {
    code: "commerce_setting_runtime_not_ready",
    path: ["key"],
    rule: "Live settings changes require a qualified runtime consumer.",
    hint: "Read the key's runtime reason and existing change mechanism.",
    remediation: { retry: false, action: "Review the catalogue for the key's documented change mechanism.", command: "npm run settings -- list" },
  },
  ...settingDescriptors.flatMap(entry => entry.rules.map(rule => ({
    code: rule.code,
    path: rule.path,
    rule: rule.description,
    hint: `Check the value schema and examples for ${entry.key}.`,
    remediation: { retry: true, action: "Check the schema and correct the rejected value.", command: settingCommand(entry.key) },
  }))),
];

export const settingsVersion = 1;


const paths = {
  catalogue: "packages/platform/settings-catalog.json",
  refusals: "packages/platform/settings-refusals.json",
  guide: "packages/core/docs/guide/how-to/operate/settings-catalogue.md",
} as const;

export function renderSettingsCatalogue(): Readonly<Record<string, string>> {
  const guide = [
    "# Settings catalogue",
    "",
    "<!-- Generated by scripts/settings-catalogue.ts. Edit the domain descriptors. -->",
    "<!-- npm-scripts: starter -->",
    "",
    "Use this catalogue with [Configure settings](configure-settings.md). Each entry includes a command that runs offline in the starter.",
    "",
    ...settingsCatalogue.flatMap(entry => [
      `## ${entry.key}`,
      "",
      entry.goal,
      `Search terms include ${settingSynonyms(entry)}.`,
      "",
      `- Owner **${entry.domain}** · kind **${entry.kind}** · runtime **${entry.runtime.level}**`,
      `- Default ${entry.fallback === null ? "uses the documented behavior below." : `is \`${JSON.stringify(entry.fallback)}\`.`}`,
      `- Basis \`${entry.defaultBasis.kind}\`${entry.defaultBasis.kind === "reference-code" ? " (matches the reference deployment's code)" : ""}.`,
      `- ${entry.whyThisDefault}`,
      ...(entry.absentMeans ? [`- When absent, ${entry.absentMeans.description.charAt(0).toLowerCase()}${entry.absentMeans.description.slice(1)}`] : []),
      "",
      "```sh",
      settingCommand(entry.key),
      "```",
      "",
    ]),
  ].join("\n");
  const json = (value: unknown) => JSON.stringify(value, null, 2) + "\n";
  return {
    [paths.catalogue]: json({ schemaVersion: settingsVersion, entries: settingsCatalogue, searchTerms }),
    [paths.refusals]: json({ schemaVersion: settingsVersion, refusals: settingRefusals }),
    [paths.guide]: guide,
  };
}

export function checkSettingsCatalogue(root: string): void {
  for (const [path, content] of Object.entries(renderSettingsCatalogue())) {
    if (readFileSync(join(root, path), "utf8") !== content)
      throw new Error(`${path} is stale. Run node scripts/settings-catalogue.ts --write.`);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv.length === 3 && process.argv[2] === "--write") {
    for (const [path, content] of Object.entries(renderSettingsCatalogue())) writeFileSync(path, content);
  } else if (process.argv.length === 2) checkSettingsCatalogue(process.cwd());
  else throw new Error("Use node scripts/settings-catalogue.ts [--write]");
}
