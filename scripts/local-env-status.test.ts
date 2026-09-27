import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const script = resolve('scripts/local-env-status.sh');
const fixtures: string[] = [];
const canaries = ['fake-service-key-canary', 'future-unknown-field-canary', 'fake-error-password-canary'];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function fixture(cliExit: number | null) {
  const root = mkdtempSync(join(tmpdir(), 'local-env-status-test-'));
  fixtures.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  mkdirSync(join(root, 'supabase'));
  writeFileSync(join(root, 'supabase/config.toml'), 'project_id = "fixture"\n[api]\nport = 51001\n[db]\nport = 51002\n[studio]\nport = 51003\n');
  const executable = (name: string, body: string) => writeFileSync(join(bin, name), `#!/bin/bash\n${body}\n`, { mode: 0o755 });
  executable('git', 'if [ "$1" = rev-parse ]; then pwd; else printf "fixture-branch\\n"; fi');
  executable('gate', 'printf "fixture-resource-status\\n"');
  executable('lsof', 'exit 1');
  executable('docker', 'printf "fixture-container-status\\n"');
  // The isolated PATH prevents missing-CLI tests from invoking the real installation.
  const awk = execFileSync('/bin/sh', ['-c', 'command -v awk'], { encoding: 'utf8' }).trim();
  executable('awk', `exec "${awk}" "$@"`);
  if (cliExit !== null) {
    executable('supabase', [
      '[ "$1" = status ] && [ "$#" = 1 ] || exit 99',
      `printf 'service_role: ${canaries[0]}\\n{"new_field":"${canaries[1]}"}\\n'`,
      `printf 'postgres://user:${canaries[2]}@localhost/db\\n' >&2`,
      `exit ${cliExit}`,
    ].join('\n'));
  }
  return { root, bin };
}

describe('local environment status credential boundary', () => {
  it.each([0, 1, null])('discards CLI stdout and stderr with exit %s', (cliExit) => {
    const { root, bin } = fixture(cliExit);
    const result = spawnSync('/bin/bash', [script], {
      cwd: root,
      env: { PATH: bin, AI_RESOURCE_GATE_BIN: join(bin, 'gate') },
      encoding: 'utf8',
      timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
    for (const canary of canaries) expect(result.stdout).not.toContain(canary);
    expect(result.stdout).toContain(`\n${cliExit === 0 ? 'available' : 'unavailable'} (connection details omitted)\n`);
    expect(result.stdout).toContain('ports api=51001 db=51002 studio=51003');
    expect(result.stdout).toContain('fixture-resource-status');
    expect(result.stdout).toContain('fixture-container-status');
    expect(result.stdout).toContain('branch=fixture-branch');
  });
});
