import { describe, expect, it } from "vitest";
import { CommerceOmsPersistenceError } from "../../src/commerce/oms/omsPorts.js";
import { neutralOmsCurrencyPolicy } from "../../src/commerce/model/omsCurrency.js";
import { readQueueSelection } from "../../src/commerce/adapters/managed/oms/queueSelection.js";
import type { CommerceOmsStore } from "../../src/commerce/adapters/managed/oms/types.js";

const LIST_REQUEST = { page: 1, pageSize: 25, sort: "created_desc" } as const;

// Derived from the function under test rather than imported by name, so the
// stub cannot drift from the signature it has to satisfy.
type QueueClient = Parameters<typeof readQueueSelection>[0];

function stubClient(result: { data?: unknown; error?: unknown }): QueueClient {
  return {
    rpc: () => Promise.resolve({ data: result.data ?? null, error: result.error ?? null }),
  } as unknown as QueueClient;
}

describe("managed commerce OMS queue selection", () => {
  it("parses additive summary totals and passes request filters to the RPC", async () => {
    const calls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
    const client = {
      rpc(functionName: string, args: Record<string, unknown>) {
        calls.push({ functionName, args });
        return Promise.resolve({
          error: null,
          data: {
            orderIds: ["42222222-2222-4222-8222-222222222221"],
            totalCount: 1,
            matches: {
              "42222222-2222-4222-8222-222222222221": {
                field: "email",
                label: "Email",
                valuePreview: "pe***@example.invalid",
              },
              ignored: { field: "raw_email", label: "", valuePreview: "person@example.invalid" },
            },
            summaryCounts: { needsAttention: 1 },
            summaryTotals: {
              gmv: { amountMinor: 12900, currency: "XXX" },
              aov: { amountMinor: 12900, currency: "XXX" },
              orderCount: 1,
              newSubscriptionCount: 0,
            },
          },
        });
      },
    } as unknown as CommerceOmsStore;

    const selection = await readQueueSelection(client, {
      page: 2,
      pageSize: 25,
      search: "OMS",
      status: "paid",
      attentionOnly: true,
      nextAction: "create_fulfillment",
      providerOpsStatus: "provider_dispatched_not_picked",
      sort: "attention_priority_desc",
    });

    expect(calls).toEqual([
      expect.objectContaining({
        functionName: "commerce_oms_admin_list_queue",
        args: expect.objectContaining({
          p_page: 2,
          p_page_size: 25,
          p_search: "OMS",
          p_status: "paid",
          p_attention_only: true,
          p_next_action: "create_fulfillment",
          p_provider_ops_status: "provider_dispatched_not_picked",
          p_sort: "attention_priority_desc",
          // The RPC declares no parameter defaults, so an omitted argument does
          // not fall back -- it fails to resolve. Pinning it here is what keeps
          // the adapter and the 17-argument identity from drifting apart.
          p_include_withdrawn: false,
        }),
      }),
    ]);
    expect(selection.summaryTotals).toEqual({
      gmv: { amountMinor: 12900, currency: "XXX" },
      aov: { amountMinor: 12900, currency: "XXX" },
      orderCount: 1,
      paidSubscriptionCycleCount: 0,
    });
    expect(selection.matches).toEqual({
      "42222222-2222-4222-8222-222222222221": {
        field: "email",
        label: "Email",
        valuePreview: "pe***@example.invalid",
      },
    });
  });

  it("labels an empty paid set with the platform default when the RPC reports no currency", async () => {
    // The queue RPC deliberately stopped naming a currency: `min(currency)` over
    // an empty paid set is null, and the default belongs to one module here.
    const selection = await readQueueSelection(
      stubClient({
        data: {
          orderIds: [],
          totalCount: 0,
          matches: {},
          summaryCounts: {},
          summaryTotals: {
            gmv: { amountMinor: 0, currency: null },
            aov: { amountMinor: 0, currency: null },
            orderCount: 0,
            newSubscriptionCount: 0,
          },
        },
      }),
      LIST_REQUEST,
    );

    expect(selection.summaryTotals).toEqual({
      gmv: { amountMinor: 0, currency: neutralOmsCurrencyPolicy.defaultCurrency },
      aov: { amountMinor: 0, currency: neutralOmsCurrencyPolicy.defaultCurrency },
      orderCount: 0,
      paidSubscriptionCycleCount: 0,
    });
  });

  it("names the cross-currency refusal instead of reporting a generic read failure", async () => {
    const failure = readQueueSelection(
      stubClient({
        error: { code: "P0001", message: "commerce_oms_summary_mixed_currency" },
      }),
      LIST_REQUEST,
    );

    await expect(failure).rejects.toBeInstanceOf(CommerceOmsPersistenceError);
    await expect(failure).rejects.toMatchObject({
      message: "Commerce OMS queue summary spans more than one currency",
      details: { reason: "commerce_oms_summary_mixed_currency" },
    });
  });
});
