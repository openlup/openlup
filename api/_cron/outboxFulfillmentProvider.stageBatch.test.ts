import { describe, expect, it } from "vitest";
import {
  readFulfillmentProviderReadiness,
  selectOrderPaidFulfillmentProvider,
} from "./outboxFulfillmentProvider.js";
import { COMMERCE_ORDER_PAID_EVENT_TYPE } from "../../src/domains/commerce/outboxEventContracts.js";

describe("outbox OmniPack controlled stage batch readiness", () => {
  it("selects the OmniPack stage bridge for a controlled small batch only after the batch gate", () => {
    const selection = selectOrderPaidFulfillmentProvider(fakeClient() as never, controlledStageBatchEnv() as never);

    expect(selection).toMatchObject({
      eventType: COMMERCE_ORDER_PAID_EVENT_TYPE,
      providerKind: "omnipack",
      readiness: { ok: true },
    });
    expect(selection.port).toBeTruthy();
  });

  it("blocks controlled OmniPack stage batch when the max-order proof does not match", () => {
    expect(readFulfillmentProviderReadiness({
      ...controlledStageBatchEnv(),
      COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "4",
      COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "4",
      OMNIPACK_STAGE_BATCH_MAX_ORDERS: "3",
    } as never)).toEqual({
      ok: false,
      error: "omnipack_stage_batch_max_orders_must_match_dispatch_limit",
    });
  });
});

function controlledStageBatchEnv(): Record<string, string> {
  return {
    COMMERCE_FULFILLMENT_AUTO_DISPATCH_PROVIDER: "omnipack",
    OMNIPACK_PROVIDER_ENABLED: "true",
    COMMERCE_OMNIPACK_DISPATCH_ENABLED: "true",
    COMMERCE_OMNIPACK_DISPATCH_MODE: "stage",
    COMMERCE_OMNIPACK_DISPATCH_BATCH_LIMIT: "3",
    COMMERCE_OUTBOX_DISPATCH_BATCH_SIZE: "3",
    OMNIPACK_STAGE_BATCH_CONFIRMED: "true",
    OMNIPACK_STAGE_BATCH_MAX_ORDERS: "3",
    OMNIPACK_USERNAME: "stage-user",
    OMNIPACK_PASSWORD: "stage-pass",
    OMNIPACK_BASE_URL: "https://api.stage.omnipack.tech",
    OMNIPACK_ENV: "stage",
    OMNIPACK_WEBHOOK_TOKEN: "unguessable",
  };
}

function fakeClient() {
  return {
    from() {
      return this;
    },
    select() {
      return this;
    },
    eq() {
      return this;
    },
  };
}
