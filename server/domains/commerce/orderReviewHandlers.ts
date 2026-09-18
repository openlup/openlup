import {
  orderReviewFailure,
  orderReviewMediaConfirmSchema,
  orderReviewMediaIntentSchema,
  orderReviewSubmitSchema,
  type OrderReview,
  type OrderReviewFailure,
  type OrderReviewReadResult,
} from "../../../src/domains/commerce/orderReviewContracts.js";
import type { OrderReviewLifecyclePort } from "./orderReviewPorts.js";

type Result<T> = { ok: true; value: T; replayed?: boolean } | { ok: false; error: OrderReviewFailure };

/** HTTP-neutral customer orchestration; route composition owns bearer extraction. */
export function createOrderReviewHandlers(port: OrderReviewLifecyclePort) {
  return {
    async read(grant: string): Promise<Result<OrderReviewReadResult>> {
      try {
        const result = await port.read(grant);
        return result ? { ok: true, value: result } : { ok: false, error: { kind: "unavailable" } };
      } catch (error) {
        return { ok: false, error: orderReviewFailure(errorCode(error)) };
      }
    },
    async submit(input: unknown) {
      const parsed = orderReviewSubmitSchema.safeParse(input);
      if (!parsed.success) return invalid();
      try {
        const result = await port.submit(parsed.data);
        return { ok: true as const, value: result.value, replayed: result.replayed };
      } catch (error) {
        return failure(error);
      }
    },
    async createMediaIntent(input: unknown) {
      const parsed = orderReviewMediaIntentSchema.safeParse(input);
      if (!parsed.success) return invalid();
      try {
        const result = await port.createMediaIntent(parsed.data);
        return { ok: true as const, value: result, replayed: result.replayed };
      } catch (error) {
        return failure(error);
      }
    },
    async confirmMedia(input: unknown) {
      const parsed = orderReviewMediaConfirmSchema.safeParse(input);
      if (!parsed.success) return invalid();
      try {
        const result = await port.confirmMedia(parsed.data);
        return { ok: true as const, value: result.value, replayed: result.replayed };
      } catch (error) {
        return failure(error);
      }
    },
  };
}

function invalid() { return { ok: false as const, error: { kind: "invalid" as const } }; }
function failure(error: unknown) { return { ok: false as const, error: orderReviewFailure(errorCode(error)) }; }
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}
