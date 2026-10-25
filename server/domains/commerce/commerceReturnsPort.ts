// Reference reason policy; the schema implementation is owned by the package.
import type { z } from "zod";
import { createCommerceReturnsSchemas, type CommerceReturnsPort as ReturnsPort } from "@openlup/platform/commerce";

export const { returnRequestCreateSchema } = createCommerceReturnsSchemas([
  "damaged", "wrong_item", "not_as_described", "pet_refused", "changed_mind", "other",
]);
export type ReturnRequestCreateInput = z.infer<typeof returnRequestCreateSchema> & { requestedBy?: string | null };
export type CommerceReturnsPort = ReturnsPort<ReturnRequestCreateInput["reasonCode"]>;

export {
  returnRequestLineSchema,
  returnApproveSchema,
  returnRejectSchema,
  type ReturnApproveInput,
  type ReturnRejectInput,
  type ReturnLifecycleResult,
} from "@openlup/platform/commerce";
