import { createManagedSurveyResponseSubmit as createSubmit, type ManagedSurveyResponseSubmitDeps as SubmitDeps } from "@openlup/platform/marketing/server";
export type { ManagedSurveyResponseGateway } from "@openlup/platform/marketing/server";
export type ManagedSurveyResponseSubmitDeps = Omit<SubmitDeps, "renderNotificationHtml" | "notificationSubject">;
export function createManagedSurveyResponseSubmit(deps: ManagedSurveyResponseSubmitDeps) {
  return createSubmit({
    // Preserve the original dependency object's live configuration reads.
    get gateway() { return deps.gateway; },
    get delivery() { return deps.delivery; },
    get notifyTo() { return deps.notifyTo; },
    get fromEmail() { return deps.fromEmail; },
    get windowMinutes() { return deps.windowMinutes; },
    get maxPerIp() { return deps.maxPerIp; },
    now: deps.now,
    renderNotificationHtml: renderSurveyEmail,
    notificationSubject: (surveyType, now) => `[Interzoo Survey] New ${surveyType} response — ${now.toISOString().slice(0, 16).replace("T", " ")} UTC`,
  });
}

function renderSurveyEmail(type: "producer" | "consumer", data: Record<string, unknown>, id: string): string {
  const label = type === "producer" ? "Producer (B2B)" : "Consumer (B2C)";
  const rows = Object.entries(data).map(([key, value]) => `<tr><td style="padding:8px 12px;font-size:13px;color:#666;white-space:nowrap;vertical-align:top;border-bottom:1px solid #eee;">${esc(key)}</td><td style="padding:8px 12px;font-size:13px;color:#111;border-bottom:1px solid #eee;">${flattenValue(value)}</td></tr>`).join("");
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"></head><body style="margin:0;padding:20px;font-family:Arial,sans-serif;background:#f5f5f5;"><div style="max-width:680px;margin:0 auto;background:#fff;border-radius:8px;padding:24px;border:1px solid #e0e0e0;"><h2 style="margin:0 0 4px 0;font-size:18px;color:#042B2C;">Interzoo 2026 — new ${esc(label)} response</h2><p style="margin:0 0 16px 0;font-size:12px;color:#888;">Response ID: ${esc(id)}</p><table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;background:#fafafa;border-radius:6px;border:1px solid #e0e0e0;">${rows}</table><details style="margin-top:16px;"><summary style="cursor:pointer;font-size:12px;color:#555;">Full JSON payload</summary><pre style="background:#f5f5f5;padding:12px;border-radius:6px;overflow:auto;font-size:11px;color:#222;">${esc(JSON.stringify(data, null, 2))}</pre></details><p style="margin:24px 0 0 0;font-size:11px;color:#999;">Submitted via kiosk tablet · Interzoo 2026 · Hall 3, Booth 3-531E</p></div></body></html>`;
}

function flattenValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (Array.isArray(value)) return value.length ? value.map(esc).join(", ") : "—";
  if (typeof value === "object") return Object.entries(value as Record<string, unknown>).map(([key, child]) => `${esc(key)}: ${esc(child)}`).join(" · ");
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return esc(value);
}

function esc(value: unknown): string {
  return String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
