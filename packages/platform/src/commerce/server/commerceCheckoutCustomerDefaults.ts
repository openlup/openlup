import type { HttpResponse } from "../../http/index.js";
import type { BffResponder } from "../../bff/index.js";
import type { z } from "zod";
import type { CheckoutKind, CommerceCustomerDefaultsReadPort } from "../contracts/index.js";
export async function readCheckoutCustomerDefaults<Snapshot>(input: {
  port: CommerceCustomerDefaultsReadPort<Snapshot> | undefined;
  clientId: string;
  checkoutKind: CheckoutKind;
  recordStage: <T>(operation: () => Promise<T>) => Promise<T>;
}, schema: z.ZodType<Snapshot>): Promise<Snapshot | null> {
  const { port, clientId, checkoutKind, recordStage } = input;
  if (!port) return null;
  const snapshot = await recordStage(() =>
    port.getCustomerDefaultsSnapshot({ clientId, checkoutKind }),
  );
  return snapshot ? schema.parse(snapshot) : null;
}


export async function readCheckoutCustomerDefaultsOrRespond<Snapshot>(input: Parameters<typeof readCheckoutCustomerDefaults<Snapshot>>[0] & { res: HttpResponse }, schema: z.ZodType<Snapshot>, responder: BffResponder): Promise<{ kind: "read"; snapshot: Snapshot | null } | { kind: "responded" }> {
  const { res, ...read } = input;
  try { return { kind: "read", snapshot: await readCheckoutCustomerDefaults(read, schema) }; }
  catch { responder.sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout customer defaults read failed", { details: { feature: "checkout", stage: "customer_defaults" } }); return { kind: "responded" }; }
}
