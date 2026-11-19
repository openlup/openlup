import { parseArgs } from 'node:util';
import { explainSetting, invalidSettingsCommand, listSettings, previewSetting, refuseSettingsPreview, showSetting, type SettingReader } from '@openlup/platform/operations/server';

const help = `Usage: npm run --silent settings -- list [--goal <text>] | show <key> | preview <key> <value> | explain <refusal-code-or-key>
Use --json for versioned output. Keep --silent on the npm command so stdout contains only JSON.
Add --help to see these examples.
For a connected show, pass --database-url <read-capable-url>.
Preview before any change. Pass the proposed value as JSON and use --database-url <read-capable-url>.
Use --sku <sku> for each SKU to inspect, --configuration <id> to select its stock source,
and --as-of <UTC-ISO-instant> to compare previews at a specific instant.

Examples:
  npm run --silent settings -- list --goal "renewal stock protection horizon"
  npm run --silent settings -- show inventory_renewal_protection --json
  npm run --silent settings -- preview inventory_renewal_protection '{"revision":"store-1","renewalProtectionDays":21}' --database-url <read-capable-url> --sku <sku> --json
  npm run --silent settings -- explain commerce_setting_unknown`;

async function run(args: string[]) {
  const commandIndex = args.findIndex(arg => arg !== '--json' && arg !== '--help');
  const previewRequested = args[commandIndex] === 'preview';
  const keyArg = args[commandIndex + 1];
  const proposalIndex = commandIndex + 2;
  // JSON accepts leading whitespace, which keeps a negative proposal positional.
  if (previewRequested && keyArg && !keyArg.startsWith('-') && /^-\d/u.test(args[proposalIndex] ?? '')) {
    args = args.map((arg, index) => index === proposalIndex ? ' ' + arg : arg);
  }
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true,
      options: {
        goal: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' }, 'database-url': { type: 'string' },
        sku: { type: 'string', multiple: true }, configuration: { type: 'string' }, 'as-of': { type: 'string' },
      },
    });
  } catch (error) {
    const parseError = error instanceof Error && 'code' in error ? error : undefined;
    const [, flag, option] = /^[^']*'(-{1,2}([\w.-]+))(?: <[^'>]+>)?'/u.exec(parseError?.message ?? '') ?? [];
    const hint = flag && (parseError?.code === 'ERR_PARSE_ARGS_INVALID_OPTION_VALUE' ? `Supply a value for ${flag} as shown in preview help.`
      : parseError?.code === 'ERR_PARSE_ARGS_UNKNOWN_OPTION' ? `Unknown option ${flag}. See preview help.` : undefined);
    print(previewRequested ? refuseSettingsPreview('commerce_setting_preview_input_invalid',
      option && hint ? { path: [option], hint } : undefined) : invalidSettingsCommand(), args.includes('--json'));
    return;
  }
  const { values, positionals: [command, value, ...extra] } = parsed;
  if (values.help) {
    if (values.json) console.log(JSON.stringify({ schemaVersion: 1, help }));
    else console.log(help);
    return;
  }

  const databaseUrl = values['database-url'];
  if ((command === 'preview' && !value) || extra.length !== (command === 'preview' ? 1 : 0) || (values.goal !== undefined && command !== 'list')
    || (databaseUrl !== undefined && (!databaseUrl || (command !== 'show' && command !== 'preview')))
    || (command !== 'preview' && (values.sku || values.configuration !== undefined || values['as-of'] !== undefined))) {
    const field = values.goal !== undefined ? 'goal' : databaseUrl === '' ? 'database-url' : !value ? 'key' : 'proposed';
    print(command === 'preview' ? refuseSettingsPreview('commerce_setting_preview_input_invalid', {
      path: [field], hint: field === 'proposed' || field === 'key' ? 'Pass the setting key and one proposed JSON value.'
        : field === 'goal' ? 'Use --goal with list.' : 'Supply a read-capable database URL.',
    }) : invalidSettingsCommand(), values.json);
    return;
  }
  if (command === 'list' && value === undefined) {
    print(listSettings({ goal: values.goal }), values.json);
  } else if (command === 'show' && value) {
    if (!databaseUrl) {
      print(await showSetting({ key: value }), values.json);
      return;
    }
    const { default: pg } = await import('pg');
    const db = new pg.Pool({ connectionString: databaseUrl });
    try {
      const { readRenewalStockProtectionOverride, describeRenewalStockProtectionSetting } = await import('@openlup/platform/inventory');
      const { readCheckoutRecoveryReminderObservation } = await import('@openlup/platform/commerce/server');
      const { checkoutWavePolicy } = await import('../owned/acquisition-policy.ts');
      const readers: Record<string, SettingReader> = {
        [describeRenewalStockProtectionSetting().key]: async () => {
          const policy = await readRenewalStockProtectionOverride(db);
          return policy ? { present: true, value: { ...policy }, revision: policy.revision } : { present: false };
        },
        checkout_recovery_reminders: () => readCheckoutRecoveryReminderObservation(db, checkoutWavePolicy),
      };
      print(await showSetting({ key: value }, readers), values.json);
    } finally {
      await db.end();
    }
  } else if (command === 'preview' && value) {
    print(await preview(value, extra[0]!, values.sku, values.configuration, values['as-of'], databaseUrl), values.json);
  } else if (command === 'explain' && value) {
    print(explainSetting(value), values.json);
  } else {
    print(invalidSettingsCommand(), values.json);
  }
}

async function preview(
  key: string, jsonValue: string, skus?: string[], configuration?: string, asOf?: string, databaseUrl?: string,
) {
  let proposed: unknown;
  try { proposed = JSON.parse(jsonValue); }
  catch { return refuseSettingsPreview('commerce_setting_preview_json_invalid'); }
  const input = { key, proposed, skus, asOf };
  if (!databaseUrl && configuration === undefined) return previewSetting(input);
  const { configurations, defaultConfigurationId, selectConfiguration } = await import('../owned/store.config.ts');
  const id = configuration ?? defaultConfigurationId;
  let sourceKey: string;
  try { sourceKey = `starter-demo:${selectConfiguration(id).id}`; }
  catch {
    return refuseSettingsPreview('commerce_setting_preview_configuration_unknown', {
      path: ['configuration'],
      hint: `Unknown configuration ${id.includes('://') ? 'ID' : JSON.stringify(id)}. Use one of these IDs: ${Object.keys(configurations).join(', ')}.`,
    });
  }
  if (!databaseUrl) return previewSetting(input);
  if (!URL.canParse(databaseUrl) || !['postgres:', 'postgresql:'].includes(new URL(databaseUrl).protocol)) {
    return refuseSettingsPreview('commerce_setting_preview_input_invalid', {
      path: ['database-url'], hint: 'Supply a PostgreSQL URL for the intended store.',
    });
  }
  const { default: pg } = await import('pg');
  const { describeRenewalStockProtectionSetting, previewRenewalStockProtection } = await import('@openlup/platform/inventory');
  const inventoryKey = describeRenewalStockProtectionSetting().key;
  const db = new pg.Pool({ connectionString: databaseUrl });
  try {
    return await previewSetting(input, {
      [inventoryKey]: (value, options) => previewRenewalStockProtection(inventoryKey, value, { ...options, db, sourceKey }),
    });
  }
  finally { await db.end(); }
}

type Result = Awaited<ReturnType<typeof preview>> | ReturnType<typeof listSettings> | Awaited<ReturnType<typeof showSetting>> | ReturnType<typeof explainSetting>;

function print(result: Result, json = false) {
  if ('refusal' in result) process.exitCode = 1;
  if (json) {
    console.log(JSON.stringify('schemaVersion' in result ? result : { schemaVersion: 1, ...result }));
  } else if ('refusal' in result || 'explanation' in result) {
    const { code, rule, hint, remediation } = 'refusal' in result ? result.refusal : result.explanation;
    console.log([code, rule, hint, remediation.action, remediation.command].join('\n'));
  } else if ('entries' in result) {
    console.log(result.entries.length
      ? result.entries.map(({ key, kind, runtime, goal, change }) =>
        `${key} (${kind}, ${runtime.level})\n  ${goal}\n  Change: ${Object.values(change).join(' ')}`).join('\n')
      : 'No settings matched the goal.');
  } else if ('validation' in result) {
    const { key, asOf, current, proposed, difference, validation, effect, uncertainty } = result;
    console.log([
      `${key} at ${asOf}`,
      `Current: ${JSON.stringify(current)}`,
      `Proposed: ${JSON.stringify(proposed)}`,
      `Horizon difference in days: ${difference?.renewalProtectionDays ?? 'unavailable'}`,
      `Validation: ${validation.state}`,
      ...(validation.state === 'valid' ? [`Normalized: ${JSON.stringify(validation.value)}`]
        : [validation.code, validation.rule, validation.hint, validation.remediation.action, validation.remediation.command]),
      'Existing reservations keep their quantities and expiry times.',
      `New purchase availability: ${effect.newPurchaseAvailability}`,
      ...effect.skus.map(row => `${row.sku}: ${row.currentAvailableForNewPurchases ?? 'unavailable'} currently available (${row.source}${row.stale ? ', stale' : ''})`),
      uncertainty,
    ].join('\n'));
  } else {
    const { setting, observation } = result;
    console.log([setting.key + ' — ' + setting.goal, `Owner: ${setting.domain}`,
      `Kind: ${setting.kind} (${setting.runtime.level})`,
      ...('reason' in setting.runtime ? [setting.runtime.reason] : []),
      `Default: ${JSON.stringify(setting.fallback)}`,
      `Basis: ${setting.defaultBasis.kind}${setting.defaultBasis.kind === 'reference-code' ? ' (matches the reference deployment’s code)' : ''}`,
      setting.whyThisDefault, ...(setting.absentMeans ? [setting.absentMeans.description] : []),
      `Schema: ${JSON.stringify(setting.schema)}`,
      `Effect: ${setting.effect.appliesTo}`,
      `Frozen on: ${setting.effect.frozenOn.join(' ') || 'No records named'}`,
      `Change: ${Object.values(setting.change).join(' ')}`,
      `Observation: ${JSON.stringify(observation)}`].join('\n'));
  }
}

await run(process.argv.slice(2));
