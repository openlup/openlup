import { parseArgs } from 'node:util';
import { explainSetting, invalidSettingsCommand, listSettings, showSetting, type SettingReader } from '@openlup/platform/operations/server';

const help = `Usage: node --experimental-strip-types host/settings.ts list [--goal <text>] | show <key> | explain <refusal-code-or-key>
Use --json for versioned output. Add --help to see these examples.
For a connected show, pass --database-url <read-capable-url>.

Examples:
  node --experimental-strip-types host/settings.ts list --goal "renewal stock protection horizon"
  node --experimental-strip-types host/settings.ts show inventory_renewal_protection --json
  node --experimental-strip-types host/settings.ts explain commerce_setting_unknown`;

async function run(args: string[]) {
  let parsed;
  try {
    parsed = parseArgs({
      args, allowPositionals: true,
      options: { goal: { type: 'string' }, json: { type: 'boolean' }, help: { type: 'boolean' }, 'database-url': { type: 'string' } },
    });
  } catch {
    print(invalidSettingsCommand(), args.includes('--json'));
    return;
  }
  const { values, positionals: [command, value, ...extra] } = parsed;
  if (values.help) {
    if (values.json) console.log(JSON.stringify({ schemaVersion: 1, help }));
    else console.log(help);
    return;
  }

  const databaseUrl = values['database-url'];
  if (extra.length || (values.goal !== undefined && command !== 'list')
    || (databaseUrl !== undefined && (command !== 'show' || !databaseUrl))) {
    print(invalidSettingsCommand(), values.json);
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
      const { readCheckoutRecoveryReminderOverride, describeCheckoutRecoveryReminderSetting, checkoutRecoveryReminderAbsence } = await import('@openlup/platform/commerce/server');
      const { checkoutWavePolicy } = await import('../owned/acquisition-policy.ts');
      const readers: Record<string, SettingReader> = {
        [describeRenewalStockProtectionSetting().key]: async () => {
          const policy = await readRenewalStockProtectionOverride(db);
          return policy ? { present: true, value: { ...policy }, revision: policy.revision } : { present: false };
        },
        [describeCheckoutRecoveryReminderSetting().key]: async () => {
          const policy = await readCheckoutRecoveryReminderOverride(db);
          if (policy) return {
            present: true, revision: policy.revision, value: { ...policy,
              abandonedCart: [...policy.abandonedCart], checkoutRecovery: [...policy.checkoutRecovery] },
          };
          return { present: false, effective: checkoutRecoveryReminderAbsence(checkoutWavePolicy) };
        },
      };
      print(await showSetting({ key: value }, readers), values.json);
    } finally {
      await db.end();
    }
  } else if (command === 'explain' && value) {
    print(explainSetting(value), values.json);
  } else {
    print(invalidSettingsCommand(), values.json);
  }
}

type Result = ReturnType<typeof listSettings> | Awaited<ReturnType<typeof showSetting>> | ReturnType<typeof explainSetting>;

function print(result: Result, json = false) {
  if ('refusal' in result) process.exitCode = 1;
  if (json) {
    console.log(JSON.stringify({ schemaVersion: 1, ...result }));
  } else if ('refusal' in result || 'explanation' in result) {
    const { code, rule, hint, remediation } = 'refusal' in result ? result.refusal : result.explanation;
    console.log([code, rule, hint, remediation.action, remediation.command].join('\n'));
  } else if ('entries' in result) {
    console.log(result.entries.length
      ? result.entries.map(({ key, kind, runtime, goal, change }) =>
        `${key} (${kind}, ${runtime.level})\n  ${goal}\n  Change: ${Object.values(change).join(' ')}`).join('\n')
      : 'No settings matched the goal.');
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
