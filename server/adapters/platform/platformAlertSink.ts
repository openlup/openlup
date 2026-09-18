import type { AlertSinkPort } from "../../../src/domains/platform/observabilityPorts.js";
import {
  createWebhookAlertSink,
  parseWebhookAlertWireFormat,
} from "../../domains/platform/webhookAlertSink.js";

const RUNBOOK_BASE_URL: string | undefined = undefined;
const SECRET_HEADER_NAME = "x-openlup-alert-secret";
const DEFAULT_TAG = "openlup";

export function createPlatformAlertSink({
  fetchImpl,
  webhookUrl,
  webhookSecret,
  wireFormat,
  environment,
}: {
  fetchImpl: typeof fetch;
  webhookUrl?: string;
  webhookSecret?: string;
  wireFormat?: string;
  environment: string;
}): AlertSinkPort {
  return createWebhookAlertSink({
    fetchImpl,
    webhookUrl,
    webhookSecret,
    options: {
      runbookUrlBase: RUNBOOK_BASE_URL,
      secretHeaderName: SECRET_HEADER_NAME,
      defaultTag: DEFAULT_TAG,
      wireFormat: parseWebhookAlertWireFormat(wireFormat),
      environment,
    },
  });
}
