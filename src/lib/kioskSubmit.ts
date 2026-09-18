import { requestBff } from "@/lib/bff/client";
import { researchSurveySubmitResponseSchema } from "@/domains/marketing/research/contracts";

const ENDPOINT = "/api/bff/marketing/research/survey-responses";

export type SurveyType = "producer" | "consumer";

type SyncStatus = "pending" | "synced" | "abandoned";

interface QueuedEntry {
  _syncStatus: SyncStatus;
  _queuedAt?: number;
  _retryAttempt?: number;
  _retryNextAt?: number;
  _lastRetryAt?: number;
  [key: string]: unknown;
}

const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 15 * 60_000;
const RETRY_MAX_ATTEMPTS = 8;
const RETRY_MAX_AGE_MS = 24 * 60 * 60_000;

function storageKey(type: SurveyType): string {
  return `${type}_survey_responses`;
}

function readQueue(type: SurveyType): QueuedEntry[] {
  try {
    const raw = localStorage.getItem(storageKey(type));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeQueue(type: SurveyType, entries: QueuedEntry[]): void {
  try {
    localStorage.setItem(storageKey(type), JSON.stringify(entries));
  } catch {
    // localStorage quota or unavailable — silent fail, network still attempted
  }
}

async function postToBff(
  type: SurveyType,
  responseData: Record<string, unknown>,
): Promise<boolean> {
  try {
    const response = await requestBff(ENDPOINT, researchSurveySubmitResponseSchema, {
      method: "POST",
      body: { surveyType: type, responseData },
    });
    return response.ok === true;
  } catch {
    return false;
  }
}

function responsePayload(entry: QueuedEntry): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(entry).filter(([key]) => !key.startsWith("_")),
  );
}

function markRetryFailure(entry: QueuedEntry, now = Date.now()): void {
  const attempt = (typeof entry._retryAttempt === "number" ? entry._retryAttempt : 0) + 1;
  entry._queuedAt = typeof entry._queuedAt === "number" ? entry._queuedAt : now;
  entry._retryAttempt = attempt;
  entry._lastRetryAt = now;
  entry._retryNextAt = now + retryDelayMs(attempt);
}

function clearRetryMetadata(entry: QueuedEntry): void {
  delete entry._retryAttempt;
  delete entry._retryNextAt;
  delete entry._lastRetryAt;
}

function shouldAbandon(entry: QueuedEntry, now = Date.now()): boolean {
  const queuedAt = typeof entry._queuedAt === "number" ? entry._queuedAt : now;
  const attempts = typeof entry._retryAttempt === "number" ? entry._retryAttempt : 0;
  return attempts >= RETRY_MAX_ATTEMPTS || now - queuedAt > RETRY_MAX_AGE_MS;
}

function retryDelayMs(attempt: number): number {
  const exponential = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1));
  if (attempt <= 1) return exponential;
  const jitter = Math.floor(exponential * 0.2 * Math.random());
  return exponential + jitter;
}

function nextDelayForPending(entries: QueuedEntry[], now = Date.now()): number | null {
  const dueTimes = entries
    .filter((entry) => entry._syncStatus === "pending")
    .map((entry) => typeof entry._retryNextAt === "number" ? entry._retryNextAt : now + RETRY_BASE_MS);
  if (dueTimes.length === 0) return null;
  return Math.max(1_000, Math.min(...dueTimes) - now);
}

const retryActive: Record<SurveyType, boolean> = {
  producer: false,
  consumer: false,
};

function startRetryQueue(type: SurveyType): void {
  if (retryActive[type]) return;
  retryActive[type] = true;
  const tick = async () => {
    const now = Date.now();
    const entries = readQueue(type);
    const pending = entries.filter((e) => e._syncStatus === "pending");
    if (pending.length === 0) {
      retryActive[type] = false;
      return;
    }
    let changed = false;
    for (const entry of pending) {
      if (shouldAbandon(entry, now)) {
        entry._syncStatus = "abandoned";
        changed = true;
        continue;
      }
      const nextRetryAt = typeof entry._retryNextAt === "number" ? entry._retryNextAt : now;
      if (nextRetryAt > now) continue;

      const ok = await postToBff(type, responsePayload(entry));
      if (ok) {
        entry._syncStatus = "synced";
        clearRetryMetadata(entry);
        changed = true;
      } else {
        markRetryFailure(entry, now);
        changed = true;
      }
    }
    if (changed) writeQueue(type, entries);
    const delay = nextDelayForPending(entries);
    if (delay !== null) {
      window.setTimeout(tick, delay);
    } else {
      retryActive[type] = false;
    }
  };
  window.setTimeout(tick, RETRY_BASE_MS);
}

export async function submitSurveyResponse(
  type: SurveyType,
  responseData: Record<string, unknown>,
): Promise<{ ok: boolean }> {
  const entries = readQueue(type);
  const entry: QueuedEntry = { ...responseData, _syncStatus: "pending" };
  entries.push(entry);
  writeQueue(type, entries);

  const ok = await postToBff(type, responseData);
  if (ok) {
    entry._syncStatus = "synced";
    writeQueue(type, entries);
    return { ok: true };
  }

  markRetryFailure(entry);
  writeQueue(type, entries);
  startRetryQueue(type);
  return { ok: false };
}
