import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SETTINGS_CATALOG_PATH = join(REPO_ROOT, 'packages/platform/settings-catalog.json');
const SETTINGS_HOST_PATH = join(REPO_ROOT, 'examples/neutral-store/owned/settings-host.ts');

const STARTER_POLICY_FILES = [
  'acquisition-policy.ts',
  'market.config.ts',
  'quote.config.ts',
  'quote-shipping.ts',
  'renewal.config.ts',
  'renewal-policy.ts',
  'store.config.ts',
  'subscription-editing.ts',
] as const;

const EXCLUDED_COMMERCE_SETTINGS_KEYS: Readonly<Record<string, string>> = {
  configurator_offer_layout:
    'Starter/adopter storefront UI presentation layout preference, not a platform-owned business policy setting.',
  min_product_payable_minor:
    'Database mirror of the adopter minimum payable product floor; declared in the starter as pricing.minimumProductPayableMinor (owned/settings-host.ts).',
};

const EXCLUDED_POLICY_TABLES: Readonly<Record<string, string>> = {
  client_absorption_policy:
    'Operator lead-absorption workflow table outside the current store-level settings catalogue scope.',
  comms_notification_controls:
    'Per-notification-type operational dispatch control table managed by the communications control plane, not store-level business policy.',
  platform_job_controls:
    'Infrastructure and background job pause/lease control table, not store-level business policy.',
  platform_operational_controls:
    'Infrastructure control-plane kill-switch table, not store-level business policy.',
  settings:
    'Legacy key-value counter/tester-cap display table (public.settings) outside the store-level business settings catalogue.',
  subscription_delivery_alignment_control:
    'Per-deployment fulfillment delivery-alignment operational cutover control table, not store-level business policy.',
};

const EXCLUDED_STARTER_POLICY_EXPORTS: Readonly<Record<string, string>> = {
  'acquisition-policy.ts#billingTaxPolicy':
    'Tax-ID normalization and checksum validation behavior, not a data value setting.',
  'acquisition-policy.ts#createAcquisitionFinancialPolicy':
    'Promotion row classifier and metadata validation adapter factory (behavior, not a data value).',
  'acquisition-policy.ts#customerAccountPolicy':
    'Input validation field-length bounds and synthetic demonstration phone prefix for account forms, not a business policy setting.',
  'acquisition-policy.ts#savedAddressValidation':
    'Address, phone, and tax-ID normalization and checksum validation behavior, not a data value setting.',
  'quote-shipping.ts#createQuoteShipping':
    'Shipping-policy composition adapter consuming offer.shippingMinor and offer.freeShippingFromMinor, not a standalone setting.',
  'renewal-policy.ts#renewalPolicy':
    'Application-owned post-renewal callback hook (behavior, not a data value).',
  'renewal.config.ts#accountPreferencePolicy':
    'Fictional demonstration payment-method and provider labels, not a store-level business policy setting.',
  'renewal.config.ts#demoRenewalConfig':
    'Configuration factory assembled into store.config.ts (config.renewal), whose business-policy fields are declared in owned/settings-host.ts.',
  'renewal.config.ts#demoSubscriptionCare':
    'Configuration factory assembled into store.config.ts (config.renewal.subscriptionCare), whose business-policy fields are declared in owned/settings-host.ts.',
  'store.config.ts#defaultConfigurationId':
    'Default configuration selector ID used by selectConfiguration, not a business policy setting.',
};

function collectSqlFiles(dir: string, recursive: boolean): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (recursive) files.push(...collectSqlFiles(fullPath, true));
    } else if (entry.name.endsWith('.sql')) {
      files.push(fullPath);
    }
  }
  return files.sort();
}

function scanSqlSettingsCandidates(): {
  commerceSettingsKeys: Set<string>;
  policyTables: Set<string>;
} {
  const sqlFiles = [
    ...collectSqlFiles(join(REPO_ROOT, 'supabase/migrations'), false),
    ...collectSqlFiles(join(REPO_ROOT, 'packages/platform/sql'), true),
  ];

  const commerceSettingsKeys = new Set<string>();
  const policyTables = new Set<string>();

  for (const file of sqlFiles) {
    const sql = readFileSync(file, 'utf8');

    for (const match of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?public\.([a-z_][a-z0-9_]*)\b/giu,
    )) {
      const tableName = match[1].toLowerCase();
      if (
        tableName === 'settings' ||
        /_(?:policy|policies|controls|control|settings)\b/iu.test(tableName)
      ) {
        policyTables.add(tableName);
      }
    }

    for (const match of sql.matchAll(
      /CONSTRAINT\s+commerce_settings_[^\n;]*?key\s*(?:<>|=)\s*'([a-z0-9_]+)'/giu,
    )) {
      commerceSettingsKeys.add(match[1]);
    }

    for (const match of sql.matchAll(
      /INSERT\s+INTO\s+(?:public\.)?commerce_settings\s*\([^)]*\)\s*VALUES\s*\(\s*'([a-z0-9_]+)'/giu,
    )) {
      commerceSettingsKeys.add(match[1]);
    }

    for (const match of sql.matchAll(
      /commerce_settings[\s\S]{0,160}?WHERE[\s\S]{0,80}?key\s*=\s*'([a-z0-9_]+)'/giu,
    )) {
      commerceSettingsKeys.add(match[1]);
    }

    for (const match of sql.matchAll(
      /commerce_settings[\s\S]{0,160}?WHERE[\s\S]{0,80}?key\s+IN\s*\(([^)]+)\)/giu,
    )) {
      for (const item of match[1].matchAll(/'([a-z0-9_]+)'/gu)) {
        commerceSettingsKeys.add(item[1]);
      }
    }
  }

  return { commerceSettingsKeys, policyTables };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function catalogReferencesKey(
  catalogKeys: ReadonlySet<string>,
  catalogRaw: string,
  key: string,
): boolean {
  return catalogKeys.has(key) || new RegExp(`\\b${escapeRegExp(key)}\\b`, 'u').test(catalogRaw);
}

function catalogReferencesTable(catalogRaw: string, table: string): boolean {
  return new RegExp(`\\bpublic\\.${escapeRegExp(table)}\\b`, 'u').test(catalogRaw);
}

describe('settings candidate parity', () => {
  const catalogRaw = readFileSync(SETTINGS_CATALOG_PATH, 'utf8');
  const catalog = JSON.parse(catalogRaw) as { entries: Array<{ key: string }> };
  const catalogKeys = new Set(catalog.entries.map((entry) => entry.key));
  const { commerceSettingsKeys, policyTables } = scanSqlSettingsCandidates();

  it('accounts for every public.commerce_settings SQL key in settings-catalog.json or EXCLUDED_COMMERCE_SETTINGS_KEYS', () => {
    expect(commerceSettingsKeys.size).toBeGreaterThan(0);

    const unaccounted = [...commerceSettingsKeys]
      .filter((key) => {
        const inCatalog = catalogReferencesKey(catalogKeys, catalogRaw, key);
        return !inCatalog && !Object.hasOwn(EXCLUDED_COMMERCE_SETTINGS_KEYS, key);
      })
      .sort();

    expect(
      unaccounted,
      `Unaccounted public.commerce_settings SQL key(s): ${unaccounted.join(', ')}. Add each key to packages/platform/src/<domain>/settings-data.json (and regenerate settings-catalog.json) or record a reason in EXCLUDED_COMMERCE_SETTINGS_KEYS.`,
    ).toEqual([]);
  });

  it('has no stale, empty, or already-catalogued entries in EXCLUDED_COMMERCE_SETTINGS_KEYS', () => {
    const invalid: string[] = [];
    for (const [key, reason] of Object.entries(EXCLUDED_COMMERCE_SETTINGS_KEYS)) {
      if (reason.trim().length === 0) invalid.push(`${key}: empty exclusion reason`);
      if (!commerceSettingsKeys.has(key)) invalid.push(`${key}: not found in SQL migrations`);
      if (catalogReferencesKey(catalogKeys, catalogRaw, key)) {
        invalid.push(`${key}: already present or referenced in settings-catalog.json`);
      }
    }
    expect(invalid).toEqual([]);
  });

  it('accounts for every SQL policy/controls/settings table in settings-catalog.json or EXCLUDED_POLICY_TABLES', () => {
    expect(policyTables.size).toBeGreaterThan(0);

    const unaccounted = [...policyTables]
      .filter(
        (table) => !catalogReferencesTable(catalogRaw, table) && !Object.hasOwn(EXCLUDED_POLICY_TABLES, table),
      )
      .sort();

    expect(
      unaccounted,
      `Unaccounted SQL policy/controls/settings table(s): ${unaccounted.join(', ')}. Reference each table in settings-catalog.json or record a reason in EXCLUDED_POLICY_TABLES.`,
    ).toEqual([]);
  });

  it('has no stale, empty, or already-catalogued entries in EXCLUDED_POLICY_TABLES', () => {
    const invalid: string[] = [];
    for (const [table, reason] of Object.entries(EXCLUDED_POLICY_TABLES)) {
      if (reason.trim().length === 0) invalid.push(`${table}: empty exclusion reason`);
      if (!policyTables.has(table)) invalid.push(`${table}: not found in SQL migrations`);
      if (catalogReferencesTable(catalogRaw, table)) {
        invalid.push(`${table}: already referenced in settings-catalog.json`);
      }
    }
    expect(invalid).toEqual([]);
  });

  it('accounts for every starter policy/config export in owned/settings-host.ts or EXCLUDED_STARTER_POLICY_EXPORTS', () => {
    const settingsHostSource = readFileSync(SETTINGS_HOST_PATH, 'utf8');
    const discovered = new Map<string, boolean>();

    for (const file of STARTER_POLICY_FILES) {
      const source = readFileSync(join(REPO_ROOT, 'examples/neutral-store/owned', file), 'utf8');
      for (const match of source.matchAll(
        /^export\s+(?:async\s+)?(?:const|function)\s+([A-Za-z0-9_]+)\b/gmu,
      )) {
        const symbol = match[1];
        const id = `${file}#${symbol}`;
        const referencedInHost = new RegExp(`\\b${escapeRegExp(symbol)}\\b`, 'u').test(
          settingsHostSource,
        );
        discovered.set(id, referencedInHost);
      }
    }

    expect(discovered.size).toBeGreaterThan(0);

    const unaccounted = [...discovered.entries()]
      .filter(([id, referencedInHost]) => !referencedInHost && !Object.hasOwn(EXCLUDED_STARTER_POLICY_EXPORTS, id))
      .map(([id]) => id)
      .sort();

    expect(
      unaccounted,
      `Unaccounted starter policy export(s): ${unaccounted.join(', ')}. Declare them in examples/neutral-store/owned/settings-host.ts or record a reason in EXCLUDED_STARTER_POLICY_EXPORTS.`,
    ).toEqual([]);

    const invalidExclusions: string[] = [];
    for (const [id, reason] of Object.entries(EXCLUDED_STARTER_POLICY_EXPORTS)) {
      if (reason.trim().length === 0) invalidExclusions.push(`${id}: empty exclusion reason`);
      if (!discovered.has(id)) invalidExclusions.push(`${id}: export not found in starter policy files`);
      else if (discovered.get(id)) {
        invalidExclusions.push(`${id}: already referenced in examples/neutral-store/owned/settings-host.ts`);
      }
    }
    expect(invalidExclusions).toEqual([]);
  });
});
