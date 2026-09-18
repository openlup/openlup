import type { AlertSeverity } from "./observabilityContracts.js";

/**
 * Helpers for delivering platform alerts in ntfy's native HTTP format.
 *
 * ntfy renders a notification from the POST body (message text) plus headers
 * (`Title`, `Priority`, `Tags`, `Click`). It does NOT read those fields from a
 * JSON body posted to `/{topic}` — a JSON body shows up as raw text. So when the
 * webhook points at an ntfy topic we must emit headers, not a JSON envelope.
 */

/** ntfy priority scale is 1 (min) .. 5 (max/urgent). */
const NTFY_PRIORITY_BY_SEVERITY: Record<AlertSeverity, number> = {
  p0: 5, // urgent — bypasses phone silent modes
  p1: 4, // high
  p2: 3, // default
  p3: 2, // low
};

export function ntfyPriorityForSeverity(severity: string): number {
  return NTFY_PRIORITY_BY_SEVERITY[severity as AlertSeverity] ?? 5;
}

/**
 * Whether a webhook URL points at an ntfy server (ntfy.sh or a self-hosted
 * `ntfy.*` host). Used to auto-select the native wire format; unparseable URLs
 * fall back to false (JSON envelope).
 */
export function isNtfyWebhookUrl(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === "ntfy.sh" || host === "ntfy" || host.startsWith("ntfy.");
}

/**
 * ntfy header values must be ASCII and single-line. Strip control characters and
 * transliterate the few Polish diacritics we emit; replace any remaining
 * non-ASCII with '?' so a header never breaks the request.
 */
export function sanitizeNtfyHeader(value: string): string {
  const transliterated = value
    .replace(/[ąĄ]/g, "a")
    .replace(/[ćĆ]/g, "c")
    .replace(/[ęĘ]/g, "e")
    .replace(/[łŁ]/g, "l")
    .replace(/[ńŃ]/g, "n")
    .replace(/[óÓ]/g, "o")
    .replace(/[śŚ]/g, "s")
    .replace(/[źżŹŻ]/g, "z");
  return transliterated
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[^\x20-\x7E]/g, "?")
    .trim();
}
