import { resolveStorageOrMemory } from "@/lib/browserStorage";
import { createCustomerJourneyActionKey } from "./customerJourneyActionKey";
import { readCustomerJourneyAuthContext, setCustomerJourneyAuthContext } from "./customerJourneyAuthContext";
import { customerDiagnosticHistoryBuildEnabled, customerDiagnosticHistoryEnabled } from "@/lib/flags";
import type {
  CustomerDiagnosticAction,
  CustomerDiagnosticBrowserEventInput,
  CustomerDiagnosticCode,
  CustomerDiagnosticPhase,
} from "@/domains/observability/customerJourneyDiagnostics";
import { CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION } from "@/domains/observability/customerJourneyDiagnostics";

export type CustomerJourneyDiagnosticAction = CustomerDiagnosticAction;
export type CustomerJourneyDiagnosticPhase = CustomerDiagnosticPhase;
export type CustomerJourneyDiagnosticCode = CustomerDiagnosticCode;

export type CustomerJourneyDiagnosticObservation = CustomerDiagnosticBrowserEventInput;

const PATH = "/api/bff/platform/customer-diagnostic-events";
const CONTRACT_VERSION = "customer-diagnostic-ingest.v1";
const CREDENTIAL_KEY = "customer-diagnostic-segment:v1";
const MAX_QUEUE = 16;
const DELIVERY_TIMEOUT_MS = 4_000;
const CREDENTIAL = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type QueuedObservation = CustomerJourneyDiagnosticObservation & {
  clientEventKey: string;
  accessToken: string | null;
};

export type CustomerJourneyDiagnosticReporterStatus = {
  queued: number;
  overflowDropped: number;
  deliveryUnknown: number;
  deliveryRejected: number;
};

let draining = false;
const queue: QueuedObservation[] = [];
let overflowDropped = 0;
let deliveryUnknown = 0;
let deliveryRejected = 0;
let memoryCredential: string | null = null;
let preferMemoryCredential = false;

export function setCustomerJourneyDiagnosticAuth(accessTokenAtEmission: string | null): void {
  setCustomerJourneyAuthContext(accessTokenAtEmission);
}

export function createCustomerJourneyDiagnosticActionKey(): string {
  return createCustomerJourneyActionKey();
}

/** A customer operation must never await this best-effort browser observation. */
export function reportCustomerJourneyDiagnostic(
  observation: CustomerJourneyDiagnosticObservation,
  accessTokenAtEmission: string | null = readCustomerJourneyAuthContext(),
): void {
  try {
    if (!diagnosticsEnabled()) return;
    if (queue.length >= MAX_QUEUE) {
      overflowDropped += 1;
      return;
    }
    queue.push({
      ...observation,
      ...(validDuration(observation.durationMs) ? {} : { durationMs: undefined }),
      ...(validRequestId(observation.relatedRequestId) ? {} : { relatedRequestId: undefined }),
      ...(validUuid(observation.clientActionKey) ? {} : { clientActionKey: undefined }),
      clientEventKey: createCustomerJourneyActionKey(),
      accessToken: accessTokenAtEmission,
    });
    void drain();
  } catch {
    // Diagnostics are never allowed to affect the producer.
  }
}

/** Local-only delivery state for tests and developer diagnostics; never reported recursively. */
export function readCustomerJourneyDiagnosticReporterStatus(): CustomerJourneyDiagnosticReporterStatus {
  return { queued: queue.length, overflowDropped, deliveryUnknown, deliveryRejected };
}

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  while (queue.length > 0) {
    const event = queue.shift();
    if (!event) continue;
    let timeout: ReturnType<typeof globalThis.setTimeout> | null = null;
    try {
      const controller = new AbortController();
      timeout = globalThis.setTimeout(() => controller.abort(), DELIVERY_TIMEOUT_MS);
      const segmentCredential = readCredential();
      const response = await fetch(PATH, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(event.accessToken ? { Authorization: `Bearer ${event.accessToken}` } : {}),
        },
        body: JSON.stringify({
          contractVersion: CONTRACT_VERSION,
          coverageVersion: CUSTOMER_DIAGNOSTIC_COVERAGE_VERSION,
          clientEventKey: event.clientEventKey,
          ...(event.clientActionKey ? { clientActionKey: event.clientActionKey } : {}),
          ...(segmentCredential ? { segmentCredential } : {}),
          action: event.action,
          phase: event.phase,
          ...(event.code ? { code: event.code } : {}),
          ...(event.durationMs !== undefined ? { durationMs: event.durationMs } : {}),
          ...(event.relatedRequestId ? { relatedRequestId: event.relatedRequestId } : {}),
        }),
        keepalive: true,
        signal: controller.signal,
      });
      if (!response.ok) {
        if ([400, 401, 403, 409, 429].includes(response.status)) deliveryRejected += 1;
        else deliveryUnknown += 1;
        continue;
      }
      const body = await response.json().catch(() => null);
      const credential = readCommittedCredential(body);
      if (credential) writeCredential(credential);
      else deliveryUnknown += 1;
    } catch {
      // A timeout can follow a committed append. Do not retry or claim absence.
      deliveryUnknown += 1;
    } finally {
      if (timeout) globalThis.clearTimeout(timeout);
    }
  }
  draining = false;
}

function diagnosticsEnabled(): boolean {
  return customerDiagnosticHistoryBuildEnabled && customerDiagnosticHistoryEnabled();
}

function readCredential(): string | null {
  if (preferMemoryCredential && validCredential(memoryCredential)) return memoryCredential;
  try {
    const value = resolveStorageOrMemory("sessionStorage").getItem(CREDENTIAL_KEY);
    return validCredential(value) ? value : memoryCredential;
  } catch {
    return memoryCredential;
  }
}

function writeCredential(value: string): void {
  memoryCredential = value;
  try {
    resolveStorageOrMemory("sessionStorage").setItem(CREDENTIAL_KEY, value);
    preferMemoryCredential = false;
  } catch {
    // Memory preserves this tab's serial queue when a handed-over store denies methods.
    preferMemoryCredential = true;
  }
}

function readCommittedCredential(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const data = (value as { data?: unknown }).data;
  if (!data || typeof data !== "object") return null;
  const row = data as { contractVersion?: unknown; persistence?: unknown; segmentCredential?: unknown };
  return row.contractVersion === CONTRACT_VERSION && row.persistence === "committed" && validCredential(row.segmentCredential)
    ? row.segmentCredential
    : null;
}

function validCredential(value: unknown): value is string {
  return typeof value === "string" && CREDENTIAL.test(value);
}

function validUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function validRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128 && /^[A-Za-z0-9._:-]+$/.test(value);
}

function validDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 600_000;
}

export function resetCustomerJourneyDiagnosticReporterForTests(): void {
  setCustomerJourneyAuthContext(null);
  draining = false;
  queue.length = 0;
  overflowDropped = 0;
  deliveryUnknown = 0;
  deliveryRejected = 0;
  memoryCredential = null;
  preferMemoryCredential = false;
  try {
    resolveStorageOrMemory("sessionStorage").removeItem(CREDENTIAL_KEY);
  } catch {
    // A denied store has no durable credential to clear.
  }
}
