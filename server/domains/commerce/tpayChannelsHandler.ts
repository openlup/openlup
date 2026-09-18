import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  TPAY_PAYMENT_CHANNELS_CONTRACT_VERSION,
  tpayPaymentChannelsResponseSchema,
  type TpayPaymentChannel,
} from "../../../src/domains/commerce/tpayChannelsContracts.js";

export interface TpayChannelsReadPort {
  listPaymentChannels(): Promise<TpayPaymentChannel[]>;
}

export interface TpayChannelsHandlerDeps {
  channelsPort: TpayChannelsReadPort;
  enabled: () => boolean;
}

export function createTpayChannelsHandler({
  channelsPort,
  enabled,
}: TpayChannelsHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }
    if (!enabled()) {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Tpay payment channels are disabled", {
        details: {
          feature: "tpay-channels",
          featureFlag: "PAYMENTS_TPAY_SANDBOX_ENABLED",
          reason: "feature_flag_disabled",
        },
      });
      return;
    }

    const response = tpayPaymentChannelsResponseSchema.parse({
      contractVersion: TPAY_PAYMENT_CHANNELS_CONTRACT_VERSION,
      channels: await channelsPort.listPaymentChannels(),
    });
    sendBffSuccess(res, response, { contractVersion: TPAY_PAYMENT_CHANNELS_CONTRACT_VERSION });
  };
}
