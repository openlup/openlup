import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { detailResponse } from "@/domains/commerce/omsClient.fixtures";
import { actionFingerprint } from "./orderDetailActionUtils";
import type { OrderActionKind } from "./OrderDetailSections";
import { useOrderActionDrafts } from "./useOrderActionDrafts";

const ACTION_KINDS: OrderActionKind[] = [
  "note",
  "hold",
  "release",
  "createFulfillment",
  "updateAddress",
  "label",
  "handoff",
  "tracking",
  "cancel",
  "markRefunded",
];

function fingerprints(detail: OmsOrderDetail, drafts: ReturnType<typeof useOrderActionDrafts>["drafts"]) {
  return ACTION_KINDS.map((kind) =>
    actionFingerprint(kind, detail, { ...drafts, fulfillmentProviderKind: "hidden_preview_fulfillment" }),
  );
}

describe("useOrderActionDrafts", () => {
  it("clears the five typed drafts on reset and leaves the mirrored address draft alone", () => {
    const { result } = renderHook(() => useOrderActionDrafts());

    act(() => {
      result.current.setDraft("note", "call the customer");
      result.current.setDraft("labelTrackingId", "TRK-1");
      result.current.setDraft("trackingStatus", "in_transit");
      result.current.setDraft("cancelReason", "wrong size");
      result.current.setDraft("markRefundedReason", "goodwill");
      result.current.setDraft("addressDraft", (draft) => ({ ...draft, city: "Warszawa" }));
    });

    expect(result.current.drafts.note).toBe("call the customer");
    expect(result.current.drafts.addressDraft.city).toBe("Warszawa");

    act(() => result.current.reset());

    expect(result.current.drafts).toMatchObject({
      note: "",
      labelTrackingId: "",
      trackingStatus: "delivered",
      cancelReason: "",
      markRefundedReason: "",
    });
    // Not cleared: it mirrors the order's stored address and is re-seeded from the
    // refetched detail, so clearing it here would blank the address form.
    expect(result.current.drafts.addressDraft.city).toBe("Warszawa");
  });

  it("keeps one setDraft and reset identity so an effect can depend on them", () => {
    const { result, rerender } = renderHook(() => useOrderActionDrafts());
    const setDraft = result.current.setDraft;
    const reset = result.current.reset;
    act(() => result.current.setDraft("note", "x"));
    rerender();
    expect(result.current.setDraft).toBe(setDraft);
    expect(result.current.reset).toBe(reset);
  });

  // The invariant OrderDetailSheet's idempotency keys rest on. The sheet reuses a stored
  // key while the action fingerprint is unchanged, and holding the six drafts in ONE bag
  // means any keystroke rebuilds the bag. If the fingerprint read draft identity rather
  // than draft content, every render would mint a new key and a retry would land as a
  // second write.
  it("produces byte-identical action fingerprints for identical draft content in a new bag", () => {
    const detail = detailResponse().order as unknown as OmsOrderDetail;
    const { result } = renderHook(() => useOrderActionDrafts());

    act(() => {
      result.current.setDraft("note", "call the customer");
      result.current.setDraft("labelTrackingId", "TRK-1");
      result.current.setDraft("cancelReason", "wrong size");
      result.current.setDraft("markRefundedReason", "goodwill");
    });
    const before = result.current.drafts;
    const baseline = fingerprints(detail, before);

    // Round-trip an unrelated field: same content, a brand-new bag object each time.
    act(() => result.current.setDraft("labelTrackingId", "TRK-2"));
    act(() => result.current.setDraft("labelTrackingId", "TRK-1"));

    expect(result.current.drafts).not.toBe(before);
    expect(result.current.drafts).toEqual(before);
    expect(fingerprints(detail, result.current.drafts)).toEqual(baseline);
  });
});
