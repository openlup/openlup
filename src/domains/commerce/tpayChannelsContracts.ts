import { z } from "../../lib/validation/zod.js";

export const TPAY_PAYMENT_CHANNELS_CONTRACT_VERSION = "commerce.tpay.channels.v1";

export const tpayPaymentChannelSchema = z
  .object({
    id: z.string().trim().min(1).max(40),
    name: z.string().trim().min(1).max(120),
    fullName: z.string().trim().min(1).max(180),
    available: z.boolean(),
    onlinePayment: z.boolean(),
    instantRedirection: z.boolean(),
    groups: z
      .array(z.object({ id: z.number().int().nonnegative(), name: z.string().trim().min(1).max(180) }).strict())
      .max(20),
  })
  .strict();

export const tpayPaymentChannelsResponseSchema = z
  .object({
    contractVersion: z.literal(TPAY_PAYMENT_CHANNELS_CONTRACT_VERSION),
    channels: z.array(tpayPaymentChannelSchema).max(200),
  })
  .strict();

export type TpayPaymentChannel = z.infer<typeof tpayPaymentChannelSchema>;
export type TpayPaymentChannelsResponse = z.infer<typeof tpayPaymentChannelsResponseSchema>;
