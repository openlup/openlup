import type { CheckoutKind } from "../../../src/domains/commerce/checkoutContracts.js";
import {
  commerceCustomerDefaultsSnapshotSchema,
  type CommerceCustomerDefaultsSnapshot,
} from "../../../src/domains/commerce/customerDefaultsSnapshotContracts.js";
import type { CommerceCustomerDefaultsReadPort } from "../../../src/domains/commerce/ports.js";

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
