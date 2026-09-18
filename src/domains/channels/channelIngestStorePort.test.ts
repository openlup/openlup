import { describe, expect, it } from "vitest";

import {
  channelIngestStatusRank,
  isInsufficientStockError,
  CHANNEL_INGEST_HALTED_STATUSES,
  CHANNEL_INGEST_ORDERED_STATUSES,
  CHANNEL_QUARANTINE_REASONS,
} from "./channelIngestStorePort.js";

describe("channel ingest store port vocabulary", () => {
  it("ranks the ordered lane in the order the saga walks it", () => {
    const ranks = CHANNEL_INGEST_ORDERED_STATUSES.map(channelIngestStatusRank);

    expect(ranks).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("leaves every halted status unranked, exactly as the store treats them", () => {
    for (const status of CHANNEL_INGEST_HALTED_STATUSES) {
      expect(channelIngestStatusRank(status)).toBe(0);
    }
  });

  it("keeps the ordered and halted lanes disjoint", () => {
    const overlap = CHANNEL_INGEST_ORDERED_STATUSES.filter((status) =>
      (CHANNEL_INGEST_HALTED_STATUSES as readonly string[]).includes(status),
    );

    expect(overlap).toEqual([]);
  });

  it("closes the quarantine reason set at exactly the six the store checks", () => {
    expect([...CHANNEL_QUARANTINE_REASONS]).toEqual([
      "unmapped_vocabulary",
      "unmapped_sellable",
      "vat_unresolvable",
      "money_mismatch",
      "revision_conflict",
      "contract_parse_failed",
    ]);
  });
});

describe("insufficient stock recognition", () => {
  it("recognises the raise the reservation rpc actually makes", () => {
    expect(
      isInsufficientStockError(new Error("inventory_reservation_insufficient_available_stock")),
    ).toBe(true);
  });

  it("recognises the external-provider sibling of the same refusal", () => {
    expect(
      isInsufficientStockError(
        new Error("inventory_external_provider_insufficient_available_stock"),
      ),
    ).toBe(true);
  });

  it("recognises an incomplete allocation as the same class of refusal", () => {
    expect(isInsufficientStockError(new Error("inventory_reservation_allocation_incomplete"))).toBe(
      true,
    );
  });

  it("recognises the commerce conflict class the managed adapter maps it into", () => {
    const mapped = Object.assign(new Error("Inventory reservation conflict"), {
      name: "CommerceRuntimeConflictError",
      code: "23514",
    });

    expect(isInsufficientStockError(mapped)).toBe(true);
  });

  it("does not treat an unrelated commerce conflict as a stock refusal", () => {
    const mapped = Object.assign(new Error("Inventory reservation conflict"), {
      name: "CommerceRuntimeConflictError",
      code: "23505",
    });

    expect(isInsufficientStockError(mapped)).toBe(false);
  });

  it.each([
    ["a transport failure", new Error("Connection terminated unexpectedly")],
    ["a permission error", new Error("permission denied")],
    ["nothing", null],
    ["a string", "insufficient"],
  ])("does not mistake %s for a stock refusal", (_label, error) => {
    expect(isInsufficientStockError(error)).toBe(false);
  });
});
