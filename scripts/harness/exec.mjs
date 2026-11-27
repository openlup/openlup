import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { env as processEnvironment, platform as processPlatform } from 'node:process';
import { fileURLToPath } from 'node:url';

export const DARWIN_PREFERRED_PATH_PREFIXES = [
  '/opt/homebrew/opt/node@24/bin',
  '/opt/homebrew/bin',
];

function resolveCanonicalPath(filePath) {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

/**
 * Returns true when `metaUrl` is the directly executed CLI script, resolving
 * symlinks via `fs.realpathSync` so symlinked bin wrappers still invoke `main()`.
 */
export function isDirectCliInvocation(metaUrl, argv1) {
  if (typeof metaUrl !== 'string' || typeof argv1 !== 'string' || argv1.trim() === '') {
    return false;
  }
  try {
    return resolveCanonicalPath(fileURLToPath(metaUrl)) === resolveCanonicalPath(argv1);
  } catch {
    return false;
  }
}

/**
 * Normalizes PATH without duplicating entries. On macOS, prepends existing
 * Homebrew Node 24 / Homebrew bin directories when present on disk.
 */
export function normalizePath(
  existingPath = processEnvironment.PATH ?? '',
  options = {},
) {
  const {
    platform = processPlatform,
    delimiter = path.delimiter,
    existsSync = fs.existsSync,
  } = options;

  const parts = String(existingPath ?? '')
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const prefixes =
    platform === 'darwin'
      ? DARWIN_PREFERRED_PATH_PREFIXES.filter((dir) => {
          try {
            return existsSync(dir);
          } catch {
            return false;
          }
        })
      : [];

  const seen = new Set();
  const ordered = [];

  for (const dir of [...prefixes, ...parts]) {
    if (!seen.has(dir)) {
      seen.add(dir);
      ordered.push(dir);
    }
  }

  return ordered.join(delimiter);
}

export function buildEnv(extraEnv = {}) {
  const base = { ...processEnvironment, ...extraEnv };
  base.PATH = normalizePath(extraEnv.PATH ?? processEnvironment.PATH ?? '');
  return base;
}

/**
 * Safe execFileSync wrapper that normalizes PATH and never throws silently.
 * Always returns { status, stdout, stderr, error, signal }.
 */
export function execCommand(command, args = [], options = {}) {
  if (typeof command !== 'string' || command.trim() === '') {
    return {
      status: 1,
      stdout: '',
      stderr: '',
      signal: null,
      error: new Error('Invalid command: must be a non-empty string'),
    };
  }

  const {
    cwd,
    env,
    input,
    stdio,
    timeout,
    maxBuffer = 10 * 1024 * 1024,
  } = options;

  const execOpts = {
    encoding: 'utf8',
    env: buildEnv(env),
    maxBuffer,
  };

  if (cwd !== undefined) execOpts.cwd = cwd;
  if (input !== undefined) execOpts.input = input;
  if (stdio !== undefined) execOpts.stdio = stdio;
  if (timeout !== undefined) execOpts.timeout = timeout;

  try {
    const out = execFileSync(command, args, execOpts);
    return {
      status: 0,
      stdout: typeof out === 'string' ? out : (out ? out.toString('utf8') : ''),
      stderr: '',
      signal: null,
      error: null,
    };
  } catch (err) {
    const stdout = typeof err?.stdout === 'string'
      ? err.stdout
      : (err?.stdout ? err.stdout.toString('utf8') : '');
    const stderr = typeof err?.stderr === 'string'
      ? err.stderr
      : (err?.stderr ? err.stderr.toString('utf8') : '');
    const signal = err?.signal ?? null;
    let status;
    if (typeof err?.status === 'number') {
      status = err.status;
    } else if (err?.code === 'ENOENT') {
      status = 127;
    } else if (signal) {
      status = 128;
    } else {
      status = 1;
    }

    return {
      status,
      stdout,
      stderr,
      signal,
      error: err instanceof Error ? err : new Error(String(err)),
    };
  }
}
