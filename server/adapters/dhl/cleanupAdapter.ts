import type { createClient } from "@supabase/supabase-js";
import type {
  FulfillmentDhlCleanupPort as CleanupPort,
  FulfillmentDhlShipmentPort as ShipmentPort,
} from "../../../src/domains/fulfillment/ports.js";
import type { Database as Schema } from "../../../src/integrations/supabase/types.js";
import { createServiceRoleClient } from "../../_lib/admin-domain/auth.js";
import { createCleanupAction, type CleanupResponse } from "./cleanupAction.js";

type ManagedClient = ReturnType<typeof createClient<Schema>>;
type TesterUpdate = Schema["public"]["Tables"]["testers"]["Update"];

type LegacyCleanupResponse = CleanupResponse;

export type CleanupRuntimeEnv = Record<string, string | undefined> & {
  SUPABASE_URL?: string;
  VITE_SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  DHL_API_USERNAME?: string;
  DHL_API_PASSWORD?: string;
};
export type DhlCleanupRuntimeEnv = CleanupRuntimeEnv;

export type CleanupRunner = (
  request: { accessToken: string | null; trackingNumber: string },
  env?: CleanupRuntimeEnv,
  fetchImpl?: typeof fetch,
) => Promise<{ status: number; body: LegacyCleanupResponse }>;
export type DhlCleanupRunner = CleanupRunner;

export function createDhlCleanupPort(options: {
  accessToken: string | null;
  env?: CleanupRuntimeEnv;
  runCleanup?: CleanupRunner;
}): CleanupPort {
  const executeCleanup = options.runCleanup ?? runCleanup;
  return {
    async cleanupDhlShipment({ trackingNumber }) {
      const result = await executeCleanup({
        accessToken: options.accessToken,
        trackingNumber,
      }, options.env);
      const data = result.body;
      if (result.status < 200 || result.status >= 300) {
        throw new Error(formatLegacyCleanupError(data.error ?? `cleanup_dhl_http_${result.status}`));
      }
      if (data?.error) throw new Error(formatLegacyCleanupError(data.error));

      return mapLegacyCleanupDhlResponse(data ?? {});
    },
  };
}

export function createDhlClearShipmentStatePort(client: ManagedClient): ShipmentPort {
  return {
    async createDhlShipment() {
      throw new Error("Use dhl-create-shipment route");
    },
    async getDhlLabel() {
      throw new Error("Use dhl-label route");
    },
    async mergeDhlLabels() {
      throw new Error("Use dhl-merge-labels route");
    },
    async bookDhlCourier() {
      throw new Error("Use dhl-book-courier route");
    },
    async repairDhlCourierPickup() {
      throw new Error("Use dhl-repair-courier-pickup route");
    },
    async clearDhlShipmentState({ testerId }) {
      const { error } = await client
        .from("testers")
        .update(clearDhlShipmentStateUpdate())
        .eq("id", testerId);
      if (error) throw error;
      return { testerId, cleared: true };
    },
  };
}

export function mapLegacyCleanupDhlResponse(data: LegacyCleanupResponse) {
  return {
    dhlDeleted: Boolean(data.dhl_deleted),
    dhlError: data.dhl_error ?? null,
    labelDeleted: Boolean(data.label_deleted),
    canProceed: true as const,
  };
}

export const runCleanup: CleanupRunner = async (
  request,
  env = process.env,
  fetchImpl = fetch,
) => {
  const url = env.SUPABASE_URL ?? env.VITE_SUPABASE_URL;
  const serviceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    return { status: 500, body: { error: "supabase_service_role_not_configured" } };
  }
  if (!env.DHL_API_USERNAME || !env.DHL_API_PASSWORD) {
    return { status: 500, body: { error: "dhl_credentials_not_configured" } };
  }

  const headers = new Headers({ "Content-Type": "application/json" });
  if (request.accessToken) {
    headers.set("Authorization", `Bearer ${request.accessToken}`);
  }

  const action = createCleanupAction({
    createClient: () => createServiceRoleClient({ url, serviceRoleKey }) as never,
    fetchImpl,
    username: env.DHL_API_USERNAME,
    password: env.DHL_API_PASSWORD,
  });
  const response = await action(new Request("https://openlup.local/dhl-cleanup", {
    method: "POST",
    headers,
    body: JSON.stringify({ tracking_number: request.trackingNumber }),
  }));

  return {
    status: response.status,
    body: await readCleanupJson(response),
  };
};

export const runDhlCleanup = runCleanup;

function formatLegacyCleanupError(error: unknown): string {
  return typeof error === "string" ? error : JSON.stringify(error);
}

async function readCleanupJson(response: Response): Promise<LegacyCleanupResponse> {
  const text = await response.text();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as LegacyCleanupResponse
      : { error: parsed };
  } catch {
    return { error: text.slice(0, 500) };
  }
}

export function clearDhlShipmentStateUpdate(): TesterUpdate {
  return {
    tracking_number: null,
    tracking_url: null,
    dhl_shipment_id: null,
    dhl_shipment_date: null,
    label_url: null,
  };
}
