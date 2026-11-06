import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SubscriptionProofOptions } from './browser/subscription-native-fixture.ts';

// The proof wrapper starts installed/seeded PostgreSQL hosts with --database-url.
// No implicit fallback to the database-less preview or a running developer host.
const hosts: unknown = JSON.parse(readFileSync('.context/database-ui-hosts.json', 'utf8'));
if (!Array.isArray(hosts) || hosts.length !== 2 || hosts.some(host =>
  !host || !['supplements', 'coffee'].includes(host.id)
  || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(host.baseURL))) throw new Error('starter_database_ui_hosts_required');
if (new Set(hosts.map(host => host.id)).size !== 2) throw new Error('starter_database_ui_hosts_required');
export default defineConfig<SubscriptionProofOptions>({
  testDir: './browser', testMatch: ['journey.spec.ts','subscription-journeys.spec.ts','subscription-api.spec.ts'], workers: 1, fullyParallel: false,
  use: { headless: true, trace: 'off', screenshot: 'off', video: 'off' },
  // Captured request bodies contain private capabilities; never persist traces.
  projects: hosts.map(host => ({ name: host.id, use: { baseURL: host.baseURL,...(typeof host.composeProject === 'string' ? { composeProject: host.composeProject } : {}) } })),
});
