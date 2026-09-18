import { useCallback, useState, type SetStateAction } from "react";
import { EMPTY_ADDRESS_DRAFT, type AddressDraft } from "./ordersPageUtils";
import type { TrackingStatus } from "./OrderDetailSections";

// Every form value the order detail sheet's actions read. `actionFingerprint` already
// consumed these as one bag, so the shape was implied long before it was declared;
// holding them as six independent `useState` calls only meant the sheet handed six
// values and six setters down two component levels to reach one leaf.
export type OrderActionDrafts = {
  note: string;
  labelTrackingId: string;
  trackingStatus: TrackingStatus;
  cancelReason: string;
  markRefundedReason: string;
  addressDraft: AddressDraft;
};

export type SetOrderActionDraft = <K extends keyof OrderActionDrafts>(
  field: K,
  value: SetStateAction<OrderActionDrafts[K]>,
) => void;

const INITIAL_DRAFTS: OrderActionDrafts = {
  note: "",
  labelTrackingId: "",
  trackingStatus: "delivered",
  cancelReason: "",
  markRefundedReason: "",
  addressDraft: EMPTY_ADDRESS_DRAFT,
};

// The five drafts an operator TYPES, cleared once an action succeeds.
//
// `addressDraft` is deliberately not among them and never was: it is a mirror of the
// order's stored shipping address, re-seeded from the refetched detail, not a field the
// operator empties. Clearing it here would blank the address form after every action.
// That asymmetry used to live in two unrelated places - the mutation's onSuccess and an
// effect - with nothing naming it; `reset` is now its single owner.
const TYPED_DRAFT_RESET = {
  note: INITIAL_DRAFTS.note,
  labelTrackingId: INITIAL_DRAFTS.labelTrackingId,
  trackingStatus: INITIAL_DRAFTS.trackingStatus,
  cancelReason: INITIAL_DRAFTS.cancelReason,
  markRefundedReason: INITIAL_DRAFTS.markRefundedReason,
} satisfies Partial<OrderActionDrafts>;

export function useOrderActionDrafts(): {
  drafts: OrderActionDrafts;
  setDraft: SetOrderActionDraft;
  reset: () => void;
} {
  const [drafts, setDrafts] = useState<OrderActionDrafts>(INITIAL_DRAFTS);

  // Stable across renders so callers can depend on it from an effect without
  // re-running the effect on every keystroke.
  const setDraft = useCallback<SetOrderActionDraft>((field, value) => {
    setDrafts((previous) => ({
      ...previous,
      [field]: typeof value === "function"
        ? (value as (prior: OrderActionDrafts[typeof field]) => OrderActionDrafts[typeof field])(previous[field])
        : value,
    }));
  }, []);

  const reset = useCallback(() => {
    setDrafts((previous) => ({ ...previous, ...TYPED_DRAFT_RESET }));
  }, []);

  return { drafts, setDraft, reset };
}
