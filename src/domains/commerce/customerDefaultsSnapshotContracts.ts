import { z } from "../../lib/validation/zod.js";
import { customerPaymentMethodKindSchema, customerPaymentPreferenceScopeSchema } from "../customers/contracts.js";
import { createCustomerDefaultsSnapshotSchemas } from "@openlup/platform/commerce";
export { CUSTOMER_DEFAULTS_SNAPSHOT_VERSION, commerceCustomerDefaultsRedactedFieldSchema } from "@openlup/platform/commerce";
export const { commerceCustomerDefaultsSnapshotSchema } = createCustomerDefaultsSnapshotSchemas({
  paymentPreferenceScopeSchema: customerPaymentPreferenceScopeSchema,
  paymentMethodKindSchema: customerPaymentMethodKindSchema,
  additionalForbiddenKeys: ["blik"],
});
export type CommerceCustomerDefaultsSnapshot = z.infer<
  typeof commerceCustomerDefaultsSnapshotSchema
>;
