import type { CheckoutKind } from "../../../src/domains/commerce/checkoutContracts.js";
import {
  commerceCustomerDefaultsSnapshotSchema,
  type CommerceCustomerDefaultsSnapshot,
} from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import type { CommerceCustomerDefaultsReadPort } from "../../../src/domains/commerce/ports.js";
import type { VercelResponse } from "../../_lib/types/vercel.js";
import { sendBffError } from "../../_lib/bff/response.js";

export async function readCheckoutCustomerDefaults(input: {
  port: CommerceCustomerDefaultsReadPort | undefined;
  clientId: string;
  checkoutKind: CheckoutKind;
  recordStage: <T>(operation: () => Promise<T>) => Promise<T>;
}): Promise<CommerceCustomerDefaultsSnapshot | null> {
  const { port, clientId, checkoutKind, recordStage } = input;
  if (!port) return null;
  const snapshot = await recordStage(() =>
    port.getCustomerDefaultsSnapshot({ clientId, checkoutKind }),
  );
  return snapshot ? commerceCustomerDefaultsSnapshotSchema.parse(snapshot) : null;
}

/**
 * The checkout handler's customer-defaults stage: a failed read answers the
 * request itself, so the handler only has to stop.
 */
export async function readCheckoutCustomerDefaultsOrRespond(
  input: Parameters<typeof readCheckoutCustomerDefaults>[0] & { res: VercelResponse },
): Promise<{ kind: "read"; snapshot: CommerceCustomerDefaultsSnapshot | null } | { kind: "responded" }> {
  const { res, ...read } = input;
  try {
    return { kind: "read", snapshot: await readCheckoutCustomerDefaults(read) };
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Checkout customer defaults read failed", {
      details: { feature: "checkout", stage: "customer_defaults" },
    });
    return { kind: "responded" };
  }
}
