import { describe, expect, it } from "vitest";

import {
  compareParcelPrecedence,
  currentParcel,
  currentParcelFirst,
  currentParcelFor,
  currentParcelPerOrder,
  parcelSequenceNo,
  rowsForParcel,
} from "./currentFulfillmentParcel.js";

const original = { id: "f-1", order_id: "o-1", sequence_no: 0 };
const replacement = { id: "f-2", order_id: "o-1", sequence_no: 1 };
const otherOrder = { id: "f-3", order_id: "o-2", sequence_no: 0 };

describe("the parcel that currently represents an order", () => {
  // The whole wave rests on this: while every order holds one row, every function here
  // answers with that row, so no read it backs can change its answer.
  it("answers with the only row when an order holds one", () => {
    expect(currentParcel([original])).toBe(original);
    expect(currentParcelFor([original, otherOrder], "o-1")).toBe(original);
    expect(currentParcelPerOrder([original, otherOrder]).get("o-1")).toBe(original);
    expect(currentParcelFirst([original, otherOrder])).toEqual([original, otherOrder]);
  });

  it("prefers the highest ordinal whatever order the rows arrive in", () => {
    for (const rows of [[original, replacement], [replacement, original]]) {
      expect(currentParcel(rows)).toBe(replacement);
      expect(currentParcelFor(rows, "o-1")).toBe(replacement);
      expect(currentParcelPerOrder(rows).get("o-1")).toBe(replacement);
      expect(currentParcelFirst(rows)[0]).toBe(replacement);
    }
  });

  it("treats a row read without the ordinal as the original parcel", () => {
    // A query that does not select the column, or a deployment that predates it, must not be
    // read as outranking a real replacement: the database default is 0 for the same reason.
    expect(parcelSequenceNo({ id: "f-9", order_id: "o-1" })).toBe(0);
    expect(currentParcel([{ id: "f-9", order_id: "o-1" }, replacement])).toBe(replacement);
  });

  it("breaks a same-ordinal tie by id rather than by read order", () => {
    const lower = { id: "f-a", order_id: "o-1", sequence_no: 1 };
    const higher = { id: "f-b", order_id: "o-1", sequence_no: 1 };
    expect(currentParcel([lower, higher])).toBe(higher);
    expect(currentParcel([higher, lower])).toBe(higher);
  });

  it("keeps a uuid tie-break in codepoint order, matching SQL's ORDER BY id DESC", () => {
    // `localeCompare` would fold the hyphens and disagree with the database.
    const withHyphen = { id: "a-b", order_id: "o-1", sequence_no: 1 };
    const withoutHyphen = { id: "aab", order_id: "o-1", sequence_no: 1 };
    expect(compareParcelPrecedence(withHyphen, withoutHyphen)).toBeGreaterThan(0);
    expect(currentParcel([withHyphen, withoutHyphen])).toBe(withoutHyphen);
  });

  it("groups per order and leaves each order where it first appeared", () => {
    const rows = [original, otherOrder, replacement];
    expect(currentParcelFirst(rows)).toEqual([replacement, original, otherOrder]);
    const perOrder = currentParcelPerOrder(rows);
    expect([...perOrder.keys()]).toEqual(["o-1", "o-2"]);
    expect(perOrder.get("o-2")).toBe(otherOrder);
  });

  it("answers with nothing when an order holds no fulfilment row", () => {
    expect(currentParcel([])).toBeNull();
    expect(currentParcelFor([otherOrder], "o-1")).toBeNull();
    expect(currentParcelFirst([])).toEqual([]);
  });

  it("gives a parcel its own companion rows, and every unattributed one", () => {
    // Declared, not inferred: a row that predates attribution genuinely has no
    // `fulfillment_order_id` key, and an object literal with no property in common with a
    // fully-optional type is rejected by TypeScript's weak-type check.
    type TrackingRow = { fulfillment_order_id?: string | null; provider_tracking_id: string };
    const mine: TrackingRow = { fulfillment_order_id: "f-2", provider_tracking_id: "T-NEW" };
    const sibling: TrackingRow = { fulfillment_order_id: "f-1", provider_tracking_id: "T-OLD" };
    const unattributed: TrackingRow = { provider_tracking_id: "T-LEGACY" };
    const explicitNull: TrackingRow = { fulfillment_order_id: null, provider_tracking_id: "T-NULL" };
    const rows: TrackingRow[] = [mine, sibling, unattributed, explicitNull];

    expect(rowsForParcel(rows, "f-2")).toEqual([mine, unattributed, explicitNull]);
    expect(rowsForParcel(rows, "f-1")).toEqual([sibling, unattributed, explicitNull]);
    // Nothing to narrow by is not a reason to answer with nothing: a caller with no parcel in
    // hand gets what it got before attribution existed.
    expect(rowsForParcel(rows, null)).toEqual(rows);
    expect(rowsForParcel(rows, undefined)).toEqual(rows);
    expect(rowsForParcel(rows, "")).toEqual(rows);
  });
});
