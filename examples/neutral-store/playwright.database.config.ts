import { defineConfig } from '@playwright/test';
import { readFileSync } from 'node:fs';
import type { SubscriptionProofOptions } from './browser/subscription-native-fixture.ts';

// The proof wrapper starts installed/seeded PostgreSQL hosts with --database-url.
// No implicit fallback to the database-less preview or a running developer host.
const hosts: unknown = JSON.parse(readFileSync('.context/database-ui-hosts.json', 'utf8'));
const nativeOperator = Array.isArray(hosts) && hosts.length === 1 && hosts[0]?.nativeOperator === true;
if (!Array.isArray(hosts) || hosts.length !== (nativeOperator ? 1 : 2) || hosts.some(host =>
  !host || !['supplements', 'coffee'].includes(host.id)
  || !/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(host.baseURL)
  || nativeOperator && !/^[a-z0-9-]+$/u.test(host.composeProject ?? ''))) throw new Error('starter_database_ui_hosts_required');
if (new Set(hosts.map(host => host.id)).size !== hosts.length) throw new Error('starter_database_ui_hosts_required');
// Editor journeys own Compose fixtures; lifecycle browser retains its process-hosted care recipe.
const editorProofs = hosts.every(host => typeof host.composeProject === 'string')
  ? ['subscription-journeys.spec.ts', 'subscription-api.spec.ts'] : [];
export default defineConfig<SubscriptionProofOptions>({
  testDir: './browser', testMatch: nativeOperator ? ['native-operator.proof.ts']
    : ['journey.spec.ts', 'acquisition.spec.ts', ...editorProofs], workers: 1, fullyParallel: false,
  use: { headless: true, trace: 'off', screenshot: 'off', video: 'off' },
  // Captured request bodies contain private capabilities; never persist traces.
  projects: hosts.map(host => ({ name: host.id, use: { baseURL: host.baseURL,...(typeof host.composeProject === 'string' ? { composeProject: host.composeProject } : {}) } })),
});
