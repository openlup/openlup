import { randomUUID } from "node:crypto";
import { isBffRequestReference } from "../../../src/lib/bff/contracts.js";

const CANARY_REQUEST_ID = /^bff-axiom-canary-[a-z0-9-]{1,96}$/;

/**
 * The reporter's own UUID family (`src/lib/diagnostics/customerJourneyReporter.ts`).
 * The same character pattern is mirrored in SQL so the ingest route never accepts
 * a reference the table would reject.
 */
const REPORTED_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type RequestHeaders = Record<string, string | string[] | undefined>;

/**
 * Returns a log-safe correlation ID. Browser callers cannot choose arbitrary
 * values: only the deliberately-shaped Axiom canary identifier is preserved.
 */
export function readObservedRequestId(
  headers: RequestHeaders,
  providerRequestId?: string | null,
): string {
  const callerRequestId = readHeader(headers, "x-request-id");
  if (callerRequestId && CANARY_REQUEST_ID.test(callerRequestId)) return callerRequestId;

  if (isBffRequestReference(providerRequestId)) return providerRequestId;

  return randomUUID();
}

/**
 * Closed vocabulary for a reference a browser reports about one of its own calls:
 * the reporter's UUID family, the deliberately-shaped Axiom canary, or whatever
 * the active host adapter recognises as its own request ID. Everything else is
 * free text and is dropped before storage.
 */
export function acceptsReportedRequestId(
  value: unknown,
  hostAccepts?: (candidate: string) => boolean,
): value is string {
  if (typeof value !== "string") return false;
  if (REPORTED_UUID.test(value) || CANARY_REQUEST_ID.test(value)) return true;
  return hostAccepts?.(value) === true;
}

function readHeader(headers: RequestHeaders, name: string): string | null {
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) return value.find((entry) => entry.trim())?.trim() ?? null;
  return null;
}
