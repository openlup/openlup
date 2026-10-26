import type { VercelRequest } from "../../_lib/types/vercel.js";
import { readOrCreateObservedRequestContext } from "../../_lib/observability/requestContext.js";
import { createCheckoutTimingLogger as create } from "@openlup/platform/commerce/server";
export type { CheckoutTimingStage, CheckoutTimingOutcome } from "@openlup/platform/commerce/server";
export function createCheckoutTimingLogger(req: VercelRequest) { return create(readOrCreateObservedRequestContext(req).requestId, "/api/bff/commerce/checkout"); }
