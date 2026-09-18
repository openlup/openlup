import type {
  AlertDecision,
  AlertNotificationOutcome,
  AlertSeverity,
  OpenAlert,
} from "../../../src/domains/platform/observabilityContracts.js";
import type { AlertHumanContext } from "../../../src/domains/platform/alertHumanContext.js";
import { urgencyForSeverity } from "../../../src/domains/platform/alertHumanContext.js";
import {
  isNtfyWebhookUrl,
  ntfyPriorityForSeverity,
  sanitizeNtfyHeader,
} from "../../../src/domains/platform/ntfyAlertFormat.js";
import type { AlertSinkPort } from "../../../src/domains/platform/observabilityPorts.js";

const DEFAULT_SECRET_HEADER_NAME = "x-app-alert-secret";
const DEFAULT_ALERT_TAG = "app";
const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;

export type WebhookAlertWireFormat = "auto" | "ntfy" | "json";

export interface WebhookAlertSinkOptions {
  runbookUrlBase?: string;
  secretHeaderName?: string;
  defaultTag?: string;
  environment?: string;
  /**
   * Wire format for the alert POST. `ntfy` emits native ntfy headers + a text
   * body (so Title/Priority/Tags actually render); `json` posts the rich JSON
   * envelope (for relays like Teams/Power-Automate). `auto` (default) picks ntfy
   * when the URL is an ntfy host, else json.
   */
  wireFormat?: WebhookAlertWireFormat;
  /** Bounded transport time per alert so one stalled receiver cannot block a watchdog tick. */
  timeoutMs?: number;
}

export function parseWebhookAlertWireFormat(value: string | null | undefined): WebhookAlertWireFormat {
  const normalized = value?.trim().toLowerCase();
  return normalized === "ntfy" || normalized === "json" ? normalized : "auto";
}

export function createWebhookAlertSink({
  fetchImpl,
  webhookUrl,
  webhookSecret,
  options = {},
}: {
  fetchImpl: typeof fetch;
  webhookUrl?: string;
  webhookSecret?: string;
  options?: WebhookAlertSinkOptions;
}): AlertSinkPort {
  return {
    async send(decision, alert) {
      if (!webhookUrl) {
        return {
          channel: "webhook",
          status: "skipped",
          provider: "webhook",
          error: "platform_alert_webhook_url_not_configured",
        };
      }

      return sendWebhook({ fetchImpl, webhookUrl, webhookSecret, options, decision, alert });
    },
  };
}

async function sendWebhook({
  fetchImpl,
  webhookUrl,
  webhookSecret,
  options,
  decision,
  alert,
}: {
  fetchImpl: typeof fetch;
  webhookUrl: string;
  webhookSecret?: string;
  options: WebhookAlertSinkOptions;
  decision: AlertDecision;
  alert: OpenAlert;
}): Promise<AlertNotificationOutcome> {
  const secretHeaderName = options.secretHeaderName ?? DEFAULT_SECRET_HEADER_NAME;
  const secretHeader = webhookSecret ? { [secretHeaderName]: webhookSecret } : {};
  const request = shouldSendNtfy(options.wireFormat ?? "auto", webhookUrl)
    ? ntfyRequest(decision, options, secretHeader)
    : jsonRequest(decision, alert, options, secretHeader);

  const timeoutMs = normalizedTimeoutMs(options.timeoutMs);
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), timeoutMs);
  try {
    const response = await fetchImpl(webhookUrl, {
      method: "POST",
      ...request,
      signal: abortController.signal,
    });
    if (!response.ok) {
      return {
        channel: "webhook",
        status: "failed",
        provider: "webhook",
        providerResponse: { status: response.status },
        // Receiver bodies are untrusted and may echo credentials or payloads.
        // Persist only the bounded HTTP status, never raw response text.
        error: `webhook_http_${response.status}`,
      };
    }

    return {
      channel: "webhook",
      status: "sent",
      provider: "webhook",
      providerResponse: { status: response.status },
    };
  } catch (error) {
    return {
      channel: "webhook",
      status: "failed",
      provider: "webhook",
      error: abortController.signal.aborted
        ? `webhook_request_timed_out_after_${timeoutMs}ms`
        : safeError(error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function normalizedTimeoutMs(value: number | undefined): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_WEBHOOK_TIMEOUT_MS;
  return Math.max(100, Math.min(Math.floor(value), 60_000));
}

function safeError(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 300);
}

type OutgoingRequest = { headers: Record<string, string>; body: string };

function shouldSendNtfy(wireFormat: WebhookAlertWireFormat, webhookUrl: string): boolean {
  if (wireFormat === "ntfy") return true;
  if (wireFormat === "json") return false;
  return isNtfyWebhookUrl(webhookUrl);
}

/** JSON envelope for relay receivers (Teams/Power-Automate). */
function jsonRequest(
  decision: AlertDecision,
  alert: OpenAlert,
  options: WebhookAlertSinkOptions,
  secretHeader: Record<string, string>,
): OutgoingRequest {
  return {
    headers: { "Content-Type": "application/json", ...secretHeader },
    body: JSON.stringify(webhookBody(decision, alert, options)),
  };
}

/**
 * Native ntfy request: the message text is the body; Title/Priority/Tags/Click
 * ride as headers so ntfy renders a real notification instead of a raw JSON blob.
 */
function ntfyRequest(
  decision: AlertDecision,
  options: WebhookAlertSinkOptions,
  secretHeader: Record<string, string>,
): OutgoingRequest {
  const humanContext = decision.humanContext ?? fallbackHumanContext(decision);
  const runbookUrlBase = options.runbookUrlBase;
  const defaultTag = options.defaultTag ?? DEFAULT_ALERT_TAG;
  const environment = alertEnvironment(options.environment);
  const click = clickUrlForRunbook(decision.runbookUrl, runbookUrlBase);

  const headers: Record<string, string> = {
    "Content-Type": "text/plain; charset=utf-8",
    Title: sanitizeNtfyHeader(`[${decision.severity.toUpperCase()}] ${decision.title}`),
    Priority: String(ntfyPriorityForSeverity(decision.severity)),
    Tags: sanitizeNtfyHeader([defaultTag, decision.severity, humanContext.incidentClass].join(",")),
    ...(click ? { Click: click } : {}),
    ...secretHeader,
  };

  return { headers, body: formatHumanMessage(decision, humanContext, runbookUrlBase, environment) };
}

function webhookBody(decision: AlertDecision, alert: OpenAlert, options: WebhookAlertSinkOptions): Record<string, unknown> {
  const humanContext = decision.humanContext ?? fallbackHumanContext(decision);
  const runbookUrlBase = options.runbookUrlBase;
  const defaultTag = options.defaultTag ?? DEFAULT_ALERT_TAG;
  const environment = alertEnvironment(options.environment);

  return {
    alertId: alert.id,
    dedupeKey: decision.dedupeKey,
    severity: decision.severity,
    title: decision.title,
    message: formatHumanMessage(decision, humanContext, runbookUrlBase, environment),
    environment,
    owner: decision.owner,
    runbookUrl: decision.runbookUrl,
    humanContext,
    priority: priorityForSeverity(decision.severity),
    tags: [defaultTag, decision.severity, humanContext.incidentClass],
    click: clickUrlForRunbook(decision.runbookUrl, runbookUrlBase),
    payload: decision.payload,
  };
}

function formatHumanMessage(
  decision: AlertDecision,
  humanContext: AlertHumanContext,
  runbookUrlBase: string | undefined,
  environment: string,
): string {
  return [
    `Srodowisko: ${environment}`,
    `Klasa awarii: ${humanContext.incidentClass}`,
    `Co sie zepsulo: ${decision.message}`,
    `Wplyw: ${humanContext.impact}`,
    `Pierwszy krok: ${humanContext.firstAction}`,
    `Dowod: ${evidenceSummary(decision)}`,
    `Runbook: ${clickUrlForRunbook(decision.runbookUrl, runbookUrlBase) ?? decision.runbookUrl}`,
  ].join("\n");
}

function alertEnvironment(value: string | undefined): string {
  return value?.replace(/\s+/g, " ").trim().toLowerCase().slice(0, 80) || "unknown";
}

function fallbackHumanContext(decision: AlertDecision): AlertHumanContext {
  return {
    incidentClass: "platform_watchdog",
    impact: decision.message,
    firstAction: "Open the runbook and inspect the alert payload before replaying or mutating production state.",
    urgency: urgencyForSeverity(decision.severity),
  };
}

function evidenceSummary(decision: AlertDecision): string {
  const fields = [
    ["dedupeKey", decision.dedupeKey],
    ["owner", decision.owner],
    ["jobName", decision.payload.jobName],
    ["queueName", decision.payload.queueName],
    ["reason", decision.payload.reason],
    ["count", decision.payload.count],
    ["ageSeconds", decision.payload.ageSeconds],
    ["lastSuccessAt", decision.payload.lastSuccessAt],
  ].filter(([, value]) => value !== undefined && value !== null && value !== "");

  if (fields.length === 0) return "See payload for raw evidence.";
  return fields.map(([key, value]) => `${key}=${String(value)}`).join(", ");
}

function priorityForSeverity(severity: AlertSeverity): number {
  if (severity === "p0" || severity === "p1") return 5;
  if (severity === "p2") return 4;
  return 3;
}

function clickUrlForRunbook(runbookUrl: string, runbookUrlBase: string | undefined): string | undefined {
  if (!runbookUrlBase || !runbookUrl.startsWith("/")) return undefined;
  return `${runbookUrlBase}${runbookUrl}`;
}
