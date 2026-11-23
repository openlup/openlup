import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export const DEFAULT_QUARANTINE_PATH = "config/ci-quarantine.json";
export const MAX_QUARANTINE_DURATION_DAYS = 7;
export const MS_PER_DAY = 86_400_000;

const ISO_DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:\d{2})$/;

function isValidCalendarDate(year, month, day) {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const probe = new Date(Date.UTC(year, month - 1, day));
  return (
    probe.getUTCFullYear() === year
    && probe.getUTCMonth() === month - 1
    && probe.getUTCDate() === day
  );
}

export function parseIsoDateOrTimestamp(value, fieldName, context) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: ${fieldName} must be a non-empty ISO-8601 date or timestamp`);
  }

  const dateOnlyMatch = ISO_DATE_ONLY_PATTERN.exec(value);
  if (dateOnlyMatch) {
    const year = Number(dateOnlyMatch[1]);
    const month = Number(dateOnlyMatch[2]);
    const day = Number(dateOnlyMatch[3]);
    if (!isValidCalendarDate(year, month, day)) {
      throw new Error(`${context}: ${fieldName} is not a valid calendar date: ${value}`);
    }
    const parsedMs = Date.UTC(year, month - 1, day);
    return parsedMs;
  }

  const timestampMatch = ISO_TIMESTAMP_PATTERN.exec(value);
  if (timestampMatch) {
    const year = Number(timestampMatch[1]);
    const month = Number(timestampMatch[2]);
    const day = Number(timestampMatch[3]);
    const hour = Number(timestampMatch[4]);
    const minute = Number(timestampMatch[5]);
    const second = Number(timestampMatch[6]);
    if (!isValidCalendarDate(year, month, day) || hour > 23 || minute > 59 || second > 59) {
      throw new Error(`${context}: ${fieldName} is not a valid ISO-8601 timestamp: ${value}`);
    }
    const offset = timestampMatch[8];
    if (offset !== "Z") {
      const offsetHours = Number(offset.slice(1, 3));
      const offsetMinutes = Number(offset.slice(4, 6));
      if (offsetHours > 23 || offsetMinutes > 59) {
        throw new Error(`${context}: ${fieldName} has an invalid timezone offset: ${value}`);
      }
    }
    const parsedMs = Date.parse(value);
    if (!Number.isFinite(parsedMs)) {
      throw new Error(`${context}: ${fieldName} could not be parsed as an ISO-8601 timestamp: ${value}`);
    }
    return parsedMs;
  }

  throw new Error(`${context}: ${fieldName} must be a valid ISO-8601 date or timestamp, received: ${value}`);
}

function normalizeQuarantineTestPath(rawPath, rootDir, context) {
  if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
    throw new Error(`${context}: testPath must be a non-empty relative path`);
  }
  if (rawPath.includes("\\")) {
    throw new Error(`${context}: testPath must use forward slashes: ${rawPath}`);
  }
  if (rawPath.startsWith("/")) {
    throw new Error(`${context}: testPath must be relative to rootDir: ${rawPath}`);
  }
  const segments = rawPath.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${context}: testPath must not contain empty, '.' or '..' segments: ${rawPath}`);
  }

  const resolvedRoot = resolve(rootDir);
  const absolutePath = resolve(resolvedRoot, rawPath);
  const rel = relative(resolvedRoot, absolutePath).split("\\").join("/");
  if (!rel || rel.startsWith("..") || rel.startsWith("/")) {
    throw new Error(`${context}: testPath escapes rootDir: ${rawPath}`);
  }
  if (!existsSync(absolutePath) || !statSync(absolutePath).isFile()) {
    throw new Error(`${context}: testPath does not exist on disk: ${rel}`);
  }
  return rel;
}

function requireNonEmptyString(value, fieldName, context) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: ${fieldName} must be a non-empty string`);
  }
  return value.trim();
}

export function loadCiQuarantine(quarantinePath = DEFAULT_QUARANTINE_PATH, rootDir = REPOSITORY_ROOT) {
  const absolutePath = resolve(rootDir, quarantinePath);
  const parsed = JSON.parse(readFileSync(absolutePath, "utf8"));
  const baseContext = `Invalid CI quarantine manifest at ${quarantinePath}`;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${baseContext}: expected JSON object`);
  }

  const { version, maxDurationDays, entries } = parsed;
  if (version !== 1) {
    throw new Error(`${baseContext}: version must be 1, received: ${String(version)}`);
  }
  if (
    !Number.isInteger(maxDurationDays)
    || maxDurationDays < 1
    || maxDurationDays > MAX_QUARANTINE_DURATION_DAYS
  ) {
    throw new Error(
      `${baseContext}: maxDurationDays must be an integer between 1 and ${MAX_QUARANTINE_DURATION_DAYS}, received: ${String(maxDurationDays)}`,
    );
  }
  if (!Array.isArray(entries)) {
    throw new Error(`${baseContext}: entries must be an array`);
  }

  const maxDurationMs = maxDurationDays * MS_PER_DAY;
  const seenPaths = new Set();
  const normalizedEntries = entries.map((entry, index) => {
    const context = `${baseContext} entries[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${context}: expected JSON object`);
    }

    const testPath = normalizeQuarantineTestPath(entry.testPath, rootDir, context);
    if (seenPaths.has(testPath)) {
      throw new Error(`${context}: duplicate testPath: ${testPath}`);
    }
    seenPaths.add(testPath);

    const owner = requireNonEmptyString(entry.owner, "owner", context);
    const reason = requireNonEmptyString(entry.reason, "reason", context);
    const trackingRef = requireNonEmptyString(entry.trackingRef, "trackingRef", context);
    const addedAtMs = parseIsoDateOrTimestamp(entry.addedAt, "addedAt", context);
    const expiresAtMs = parseIsoDateOrTimestamp(entry.expiresAt, "expiresAt", context);

    if (expiresAtMs <= addedAtMs) {
      throw new Error(`${context}: expiresAt (${entry.expiresAt}) must be after addedAt (${entry.addedAt})`);
    }
    if (expiresAtMs - addedAtMs > maxDurationMs) {
      throw new Error(
        `${context}: quarantine duration exceeds maxDurationDays (${maxDurationDays} days): ${entry.addedAt} -> ${entry.expiresAt}`,
      );
    }

    return {
      testPath,
      owner,
      reason,
      trackingRef,
      addedAt: entry.addedAt,
      expiresAt: entry.expiresAt,
    };
  });

  return {
    version,
    maxDurationDays,
    entries: normalizedEntries,
  };
}

function toEpochMs(now) {
  if (now instanceof Date) {
    const ms = now.getTime();
    if (!Number.isFinite(ms)) {
      throw new Error("Invalid Date passed to validateQuarantineActive");
    }
    return ms;
  }
  if (typeof now === "number") {
    if (!Number.isFinite(now)) {
      throw new Error(`Invalid timestamp passed to validateQuarantineActive: ${String(now)}`);
    }
    return now;
  }
  if (typeof now === "string") {
    return parseIsoDateOrTimestamp(now, "now", "validateQuarantineActive");
  }
  throw new Error(`Unsupported now value passed to validateQuarantineActive: ${String(now)}`);
}

export function validateQuarantineActive(manifest, now = new Date()) {
  const nowMs = toEpochMs(now);
  const expired = [];
  for (const entry of manifest.entries) {
    const expiresAtMs = parseIsoDateOrTimestamp(entry.expiresAt, "expiresAt", `validateQuarantineActive(${entry.testPath})`);
    if (expiresAtMs <= nowMs) {
      expired.push(entry);
    }
  }
  return expired;
}

export function splitQuarantinedFiles(files, manifest) {
  const byPath = new Map(manifest.entries.map((entry) => [entry.testPath, entry]));
  const normalFiles = [];
  const quarantinedEntries = [];

  for (const file of files) {
    const entry = byPath.get(file);
    if (entry) {
      quarantinedEntries.push(entry);
    } else {
      normalFiles.push(file);
    }
  }

  return {
    normalFiles,
    quarantinedEntries,
  };
}
