/**
 * CSP violation report sink.
 *
 * Target of `report-uri /api/csp-report` while the Content-Security-Policy ships
 * in Report-Only mode through adopter/host-owned response policy. The browser POSTs a violation report
 * here whenever the *target* policy would have blocked something; nothing is
 * actually blocked yet. We log structured JSON to the configured host observability so
 * we can review the violation set and tighten the policy before promoting it to
 * enforcing mode.
 *
 * Deliberately NO Supabase write and NO Origin allowlist — same rationale as
 * api/feedback-event.ts (zero persistence, low attack surface), and CSP reports
 * legitimately arrive with no usable Origin header (sent by the user agent, not
 * by page JS). We size-cap and truncate everything to bound abuse / log spam.
 *
 * Accepts both report formats:
 *   - Legacy:  content-type application/csp-report  -> { "csp-report": {...} }
 *   - Reporting API: application/reports+json        -> [ { type, body: {...} }, ... ]
 */
import type { VercelRequest, VercelResponse } from "../server/_lib/types/vercel.js";

const MAX_BODY_BYTES = 16 * 1024; // 16 KB — a report is ~1-2 KB; more = abuse.
const DEDUPE_WINDOW_MS = 5 * 60 * 1000;
const SUMMARY_EVERY_N_DUPLICATES = 25;

interface DedupeEntry {
  windowStartedAt: number;
  duplicateCount: number;
}

const reportDedupe = new Map<string, DedupeEntry>();

// Periodically evict dedupe entries whose window has elapsed so a long-lived Node process can't
// accumulate one entry per distinct violation signature forever (W4.5 — bound in-memory hot-path
// state). On Vercel the map dies with each invocation, so this is a no-op there; the eviction is
// behavior-preserving (an entry past DEDUPE_WINDOW_MS is already treated as a fresh window on its
// next hit). We sweep at most once per cleanup interval to keep the hot path cheap.
const CLEANUP_INTERVAL_MS = DEDUPE_WINDOW_MS;
let lastCleanupAt = 0;

function pruneDedupe(now: number): void {
  if (now - lastCleanupAt < CLEANUP_INTERVAL_MS) return;
  lastCleanupAt = now;
  for (const [key, entry] of reportDedupe) {
    if (now - entry.windowStartedAt > DEDUPE_WINDOW_MS) reportDedupe.delete(key);
  }
}

async function readBody(req: VercelRequest): Promise<unknown> {
  if (req.body !== undefined) return req.body;
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0;
    req.on("data", (c: Buffer) => {
      bytes += c.length;
      if (bytes > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

const truncate = (v: unknown, max = 300): string | null => {
  if (typeof v !== "string") return null;
  return v.slice(0, max).replace(/[\r\n]/g, " ");
};

function sanitizeResourceLocation(value: unknown, max = 300): string | null {
  const raw = truncate(value, 2048)?.trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") {
      const staticPath = safeStaticAssetPath(parsed.pathname);
      return `${parsed.origin}${staticPath ?? ""}`.slice(0, max);
    }
    return `scheme:${parsed.protocol.slice(0, 32)}`;
  } catch {
    const token = raw.toLowerCase().replace(/:$/, "");
    return token === "inline" || token === "eval" ? `scheme:${token}` : "invalid";
  }
}

function safeStaticAssetPath(pathname: string): string | null {
  if (!/^\/(?:assets|_next|static)\//.test(pathname)) return null;
  return /^\/(?:assets|_next|static)(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)+$/.test(pathname)
    ? pathname
    : null;
}

/** Normalize either report shape into a flat, truncated record for logging. */
function normalize(report: Record<string, unknown>): Record<string, unknown> {
  // Legacy csp-report keys are kebab-case; Reporting API body keys are camelCase.
  const get = (...keys: string[]): unknown => {
    for (const k of keys) if (report[k] != null) return report[k];
    return null;
  };
  return {
    document_uri: sanitizeResourceLocation(get("document-uri", "documentURL")),
    referrer: sanitizeResourceLocation(get("referrer")),
    violated_directive: truncate(get("violated-directive", "effectiveDirective", "effective-directive")),
    effective_directive: truncate(get("effective-directive", "effectiveDirective")),
    blocked_uri: sanitizeResourceLocation(get("blocked-uri", "blockedURL")),
    disposition: truncate(get("disposition")),
    source_file: sanitizeResourceLocation(get("source-file", "sourceFile")),
    line_number: typeof get("line-number", "lineNumber") === "number" ? get("line-number", "lineNumber") : null,
    status_code: typeof get("status-code", "statusCode") === "number" ? get("status-code", "statusCode") : null,
  };
}

function reportSignature(report: Record<string, unknown>): string {
  return [
    report.document_uri,
    report.effective_directive ?? report.violated_directive,
    report.blocked_uri,
    report.source_file,
    report.line_number,
  ].map((value) => String(value ?? "")).join("|");
}

function shouldLogReport(report: Record<string, unknown>, now = Date.now()): { log: boolean; duplicatesSuppressed?: number } {
  pruneDedupe(now);
  const key = reportSignature(report);
  const current = reportDedupe.get(key);
  if (!current || now - current.windowStartedAt > DEDUPE_WINDOW_MS) {
    reportDedupe.set(key, { windowStartedAt: now, duplicateCount: 0 });
    return { log: true };
  }

  current.duplicateCount += 1;
  if (current.duplicateCount % SUMMARY_EVERY_N_DUPLICATES === 0) {
    return { log: true, duplicatesSuppressed: current.duplicateCount };
  }
  return { log: false };
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method !== "POST") {
    res.status(405).json({ error: "method not allowed" });
    return;
  }

  let raw: unknown;
  try {
    raw = await readBody(req);
  } catch {
    // Malformed/oversized — accept silently so the browser doesn't retry-storm.
    res.status(204).end();
    return;
  }

  // Two shapes: { "csp-report": {...} } or [ { body: {...} }, ... ].
  const reports: Record<string, unknown>[] = [];
  if (raw && typeof raw === "object") {
    if (Array.isArray(raw)) {
      for (const item of raw.slice(0, 20)) {
        if (item && typeof item === "object") {
          const body = (item as Record<string, unknown>).body;
          reports.push((body && typeof body === "object" ? body : item) as Record<string, unknown>);
        }
      }
    } else {
      const legacy = (raw as Record<string, unknown>)["csp-report"];
      reports.push((legacy && typeof legacy === "object" ? legacy : raw) as Record<string, unknown>);
    }
  }

  const ts = new Date().toISOString();
  for (const report of reports) {
    const normalized = normalize(report);
    const decision = shouldLogReport(normalized);
    if (decision.log) {
      console.warn("[csp-report]", JSON.stringify({
        type: "csp_violation",
        ts,
        duplicates_suppressed: decision.duplicatesSuppressed,
        ...normalized,
      }));
    }
  }

  res.status(204).end();
}

export const config = {
  api: { bodyParser: { sizeLimit: "16kb" } },
};
