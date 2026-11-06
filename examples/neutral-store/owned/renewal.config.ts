import type { RenewalConfig } from '../shared/renewal-config.ts';
import { renewalNoticeCopy } from './renewal-copy.ts';

export function demoRenewalConfig(configuration: string): RenewalConfig {
  return { enabled: false, population: `demo:${configuration}`, cadenceSeconds: 90,
    batchLimit: 10, leaseSeconds: 180, sandbox: { initial: 'declined', retry: 'succeeded' },
    recovery: { activeGraceSeconds: 21600, exhaustedTtlSeconds: 86400 },
    notices: { locale: 'en', countryLocales: {}, copy: renewalNoticeCopy } };
}

