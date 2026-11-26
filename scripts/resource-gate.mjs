// Shared ai-resource-gate broker discovery and invocation builder.
import { createHash } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { env as processEnvironment } from 'node:process';

export const DEFAULT_QUEUE_TIMEOUT_SECONDS = 300;
export const DEFAULT_EXECUTION_TIMEOUT_SECONDS = 900;

const RESOURCE_PROFILE = /^[a-z][a-z0-9:-]{0,127}$/u;
const RESOURCE_LANE = /^[a-z][a-z0-9-]{0,63}$/u;

/** @param {string} candidate */
export function isExecutableFile(candidate) {
  try {
    accessSync(candidate, constants.X_OK);
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {(candidate: string) => boolean} [checkExecutable]
 * @returns {string | null}
 */
export function findResourceGateBinary(env = processEnvironment, checkExecutable = isExecutableFile) {
  return (env.PATH ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map(directory => join(directory, 'ai-resource-gate'))
    .find(checkExecutable) ?? null;
}

/**
 * Decimal uint64 suffix prevents lane-keyword collisions inside the broker key.
 * @param {string} cwd
 * @returns {string}
 */
export function worktreeGateSuffix(cwd) {
  return createHash('sha256').update(resolve(cwd)).digest().readBigUInt64BE().toString(10);
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {boolean}
 */
export function isResourceGateBypassed(env = processEnvironment) {
  return env.CI === 'true' || env.AI_RESOURCE_GATE_ACTIVE === '1' || env.OPENLUP_DISABLE_RESOURCE_GATE === '1';
}

/**
 * @param {{
 *   cwd: string;
 *   profile: string;
 *   command: string;
 *   args?: readonly string[];
 *   lane?: string;
 *   queueTimeout?: number | null;
 *   executionTimeout?: number | null;
 *   env?: NodeJS.ProcessEnv;
 *   checkExecutable?: (candidate: string) => boolean;
 *   requireBroker?: boolean;
 * }} options
 * @returns {{ command: string; args: string[]; key: string } | null}
 */
export function resolveResourceGateInvocation({
  cwd,
  profile,
  command,
  args = [],
  lane,
  queueTimeout = DEFAULT_QUEUE_TIMEOUT_SECONDS,
  executionTimeout = DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  env = processEnvironment,
  checkExecutable = isExecutableFile,
  requireBroker = false,
}) {
  if (typeof profile !== 'string' || !RESOURCE_PROFILE.test(profile)) {
    throw new Error('resource profile is invalid');
  }
  if (lane !== undefined && (typeof lane !== 'string' || !RESOURCE_LANE.test(lane))) {
    throw new Error('resource lane is invalid');
  }
  if (queueTimeout != null && (!Number.isSafeInteger(queueTimeout) || queueTimeout <= 0)) {
    throw new Error('resource queueTimeout must be a positive safe integer');
  }
  if (executionTimeout != null && (!Number.isSafeInteger(executionTimeout) || executionTimeout <= 0)) {
    throw new Error('resource executionTimeout must be a positive safe integer');
  }
  if (!requireBroker && isResourceGateBypassed(env)) {
    return null;
  }
  const broker = findResourceGateBinary(env, checkExecutable);
  if (!broker) {
    if (requireBroker) throw new Error('ai-resource-gate is unavailable');
    return null;
  }
  const key = `${profile}:wt${worktreeGateSuffix(cwd)}`;
  return {
    command: broker,
    args: [
      'run',
      '--wait',
      ...(lane ? ['--lane', lane] : []),
      ...(queueTimeout != null ? ['--queue-timeout', String(queueTimeout)] : []),
      ...(executionTimeout != null ? ['--execution-timeout', String(executionTimeout)] : []),
      key,
      '--',
      command,
      ...args,
    ],
    key,
  };
}
