import {
  orderReviewFailure,
  orderReviewMediaConfirmSchema,
  orderReviewMediaIntentSchema,
  orderReviewSubmitSchema,
  type OrderReview,
  type OrderReviewFailure,
  type OrderReviewReadResult,
} from "../orderReviewContracts.js";
import type { OrderReviewLifecyclePort } from "../orderReviewPorts.js";

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
      return runOrderReviewCommand(orderReviewSubmitSchema.safeParse(input), (data) => port.submit(data), (result) => result.value);
    },
    async createMediaIntent(input: unknown) {
      return runOrderReviewCommand(orderReviewMediaIntentSchema.safeParse(input), (data) => port.createMediaIntent(data), (result) => result);
    },
    async confirmMedia(input: unknown) {
      return runOrderReviewCommand(orderReviewMediaConfirmSchema.safeParse(input), (data) => port.confirmMedia(data), (result) => result.value);
    },
  };
}

/** Shared command scaffold: parse result, one port call, the value mapper, failure mapping. */
export async function runOrderReviewCommand<D, R extends { replayed?: boolean }, V>(
  parsed: { success: true; data: D } | { success: false },
  call: (data: D) => Promise<R>,
  map: (result: R) => V,
) {
  if (parsed.success === false) return invalid();
  try {
    const result = await call(parsed.data);
    return { ok: true as const, value: map(result), replayed: result.replayed };
  } catch (error) {
    return failure(error);
  }
}

function invalid() { return { ok: false as const, error: { kind: "invalid" as const } }; }
function failure(error: unknown) { return { ok: false as const, error: orderReviewFailure(errorCode(error)) }; }
function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : undefined;
}
