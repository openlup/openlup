import {
  orderReviewAdminRevokeSchema,
  orderReviewReferenceSchema,
  orderReviewModerationSchema,
  type OrderReviewFailure,
} from "../orderReviewContracts.js";
import { runOrderReviewCommand } from "./orderReviewHandlers.js";
import type { OrderReviewAdminReadPort, OrderReviewLifecyclePort } from "../orderReviewPorts.js";

type Result<T> = { ok: true; value: T; replayed?: boolean } | { ok: false; error: OrderReviewFailure };

/** Actor identity is supplied only by the already-authorized route composition. */
export function createOrderReviewAdminHandlers(
  lifecycle: OrderReviewLifecyclePort,
  readPort: OrderReviewAdminReadPort,
) {
  return {
    async list(actorRef: string, input: { cursor?: string; limit?: number }): Promise<Result<Awaited<ReturnType<OrderReviewAdminReadPort["list"]>>>> {
      if (!validActor(actorRef)) return unavailable();
      const limit = Math.min(Math.max(input.limit ?? 25, 1), 100);
      try { return { ok: true, value: await readPort.list({ actorRef, cursor: input.cursor, limit }) }; }
      catch { return unavailable(); }
    },
    async read(actorRef: string, reviewRef: string): Promise<Result<Awaited<ReturnType<OrderReviewAdminReadPort["read"]>>>> {
      if (!validActor(actorRef) || !orderReviewReferenceSchema.safeParse(reviewRef).success) return unavailable();
      try {
        const review = await readPort.read({ actorRef, reviewRef });
        return review ? { ok: true, value: review } : unavailable();
      } catch { return unavailable(); }
    },
    async moderate(actorRef: string, input: unknown) {
      if (!validActor(actorRef)) return unavailable();
      return runOrderReviewCommand(orderReviewModerationSchema.safeParse(input), (data) => lifecycle.moderate({ ...data, actorRef }), (result) => result.value);
    },
    async revoke(actorRef: string, input: { reviewRef?: string; idempotencyKey?: string }) {
      if (!validActor(actorRef)) return unavailable();
      return runOrderReviewCommand(orderReviewAdminRevokeSchema.safeParse(input), (data) => lifecycle.revoke({ ...data, actorRef }), (result) => result);
    },
  };
}

function validActor(value: string): boolean { return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(value); }
function unavailable() { return { ok: false as const, error: { kind: "unavailable" as const } }; }
