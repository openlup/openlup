import type { FulfillmentDhlShipmentPort } from "../../../src/domains/fulfillment/ports.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import {
  createCarrierLabelAction,
} from "./carrierLabelAction.js";
import { createMergeLabelDocumentsAction } from "./mergeLabelDocumentsAction.js";

interface LegacyLabelResponse {
  label_url?: string;
  error?: unknown;
}

interface LegacyMergeResponse {
  pdf_base64?: string;
  label_count?: number;
  error?: unknown;
}

export type CarrierLabelRuntimeEnv = Record<string, string | undefined>;

export type CarrierLabelRunner = (
  request: { accessToken: string | null; testerId: string },
  env?: CarrierLabelRuntimeEnv,
  fetchImpl?: typeof fetch,
) => Promise<{ status: number; body: LegacyLabelResponse }>;

export type CarrierMergeRunner = (
  request: { accessToken: string | null; testerIds: string[] },
  env?: CarrierLabelRuntimeEnv,
  fetchImpl?: typeof fetch,
) => Promise<{ status: number; body: LegacyMergeResponse }>;

export type DhlLabelRuntimeEnv = CarrierLabelRuntimeEnv;
export type DhlLabelRunner = CarrierLabelRunner;
export type DhlMergeLabelsRunner = CarrierMergeRunner;

type CarrierServiceCredentials = { url: string; serviceRoleKey: string };
type CarrierRoutePort = Omit<FulfillmentDhlShipmentPort, "getDhlLabel" | "mergeDhlLabels">;

export function createCarrierLabelPort(options: {
  accessToken: string | null;
  env?: CarrierLabelRuntimeEnv;
  runLabel?: CarrierLabelRunner;
}): FulfillmentDhlShipmentPort {
  const runLabel = options.runLabel ?? runCarrierLabel;
  return {
    ...createUnsupportedCarrierRoutePort(),
    async getDhlLabel({ testerId }) {
      const result = await runLabel({
        accessToken: options.accessToken,
        testerId,
      }, options.env);
      const data = result.body;
      if (result.status < 200 || result.status >= 300) {
        throw new Error(String(data.error ?? `get_dhl_label_http_${result.status}`));
      }
      if (data?.error) throw new Error(String(data.error));
      return mapLegacyLabelResponse(data ?? {});
    },
    async mergeDhlLabels() {
      throw new Error("Use dhl-merge-labels route");
    },
  };
}

export function createCarrierMergePort(options: {
  accessToken: string | null;
  env?: CarrierLabelRuntimeEnv;
  runMergeLabels?: CarrierMergeRunner;
}): FulfillmentDhlShipmentPort {
  const runMergeLabels = options.runMergeLabels ?? runCarrierMerge;
  return {
    ...createUnsupportedCarrierRoutePort(),
    async getDhlLabel() {
      throw new Error("Use dhl-label route");
    },
    async mergeDhlLabels({ testerIds }) {
      const result = await runMergeLabels({
        accessToken: options.accessToken,
        testerIds,
      }, options.env);
      const data = result.body;
      if (result.status < 200 || result.status >= 300) {
        throw new Error(String(data.error ?? `merge_dhl_labels_http_${result.status}`));
      }
      if (data?.error) throw new Error(String(data.error));
      return mapLegacyMergeResponse(data ?? {});
    },
  };
}

export function mapLegacyLabelResponse(data: LegacyLabelResponse) {
  return {
    labelUrl: data.label_url ?? "",
  };
}

export const runCarrierLabel: CarrierLabelRunner = async (
  request,
  env = process.env,
  fetchImpl = fetch,
) => {
  const service = resolveCarrierService(env);
  if (!service) {
    return { status: 500, body: { error: "supabase_service_role_not_configured" } };
  }
  void fetchImpl;

  const headers = new Headers({ "Content-Type": "application/json" });
  if (request.accessToken) {
    headers.set("Authorization", `Bearer ${request.accessToken}`);
  }

  const action = createCarrierLabelAction({
    createClient: () => createServiceRoleClient(service) as never,
  });
  const response = await action(new Request("https://openlup.local/dhl-label", {
    method: "POST",
    headers,
    body: JSON.stringify({ tester_id: request.testerId }),
  }));

  return {
    status: response.status,
    body: await readLabelJson(response),
  };
};

export const runCarrierMerge: CarrierMergeRunner = async (
  request,
  env = process.env,
) => {
  const service = resolveCarrierService(env);
  if (!service) {
    return { status: 500, body: { error: "supabase_service_role_not_configured" } };
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  if (request.accessToken) {
    headers.set("Authorization", `Bearer ${request.accessToken}`);
  }

  const { PDFDocument } = await import("pdf-lib");
  const action = createMergeLabelDocumentsAction({
    createClient: () => createServiceRoleClient(service) as never,
    createPdf: () => PDFDocument.create(),
    loadPdf: (bytes) => PDFDocument.load(bytes),
  });
  const response = await action(new Request("https://openlup.local/merge-dhl-labels", {
    method: "POST",
    headers,
    body: JSON.stringify({ tester_ids: request.testerIds }),
  }));

  return {
    status: response.status,
    body: await readMergeLabelsJson(response),
  };
};

export const createDhlLabelPort = createCarrierLabelPort;
export const createDhlMergeLabelsPort = createCarrierMergePort;
export const runDhlLabel = runCarrierLabel;
export const runDhlMergeLabels = runCarrierMerge;

function createUnsupportedCarrierRoutePort(): CarrierRoutePort {
  return {
    async createDhlShipment() {
      throw new Error("Use dhl-create-shipment route");
    },
    async bookDhlCourier() {
      throw new Error("Use dhl-book-courier route");
    },
    async repairDhlCourierPickup() {
      throw new Error("Use dhl-repair-courier-pickup route");
    },
    async clearDhlShipmentState() {
      throw new Error("Use dhl-clear-shipment-state route");
    },
  };
}

function resolveCarrierService(env: CarrierLabelRuntimeEnv): CarrierServiceCredentials | null {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  return url && serviceRoleKey ? { url, serviceRoleKey } : null;
}

async function readLabelJson(response: Response): Promise<LegacyLabelResponse> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LegacyLabelResponse
      : { error: parsed };
  } catch {
    return { error: text.slice(0, 500) };
  }
}

async function readMergeLabelsJson(response: Response): Promise<LegacyMergeResponse> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LegacyMergeResponse
      : { error: parsed };
  } catch {
    return { error: text.slice(0, 500) };
  }
}

export function mapLegacyMergeResponse(data: LegacyMergeResponse) {
  return {
    pdfBase64: data.pdf_base64 ?? "",
    labelCount: data.label_count ?? 0,
  };
}

export const mapLegacyGetDhlLabelResponse = mapLegacyLabelResponse;
export const mapLegacyMergeDhlLabelsResponse = mapLegacyMergeResponse;
