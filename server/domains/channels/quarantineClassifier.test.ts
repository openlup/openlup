import { describe, expect, it } from "vitest";

import {
  classifyQuarantineReason,
  contractParseQuarantine,
  quarantineVocabulary,
} from "./quarantineClassifier.js";

describe("quarantine classifier", () => {
  it.each([
    ["channel_order_money_equation_mismatch", "money_mismatch"],
    ["channel_order_line_sum_mismatch", "money_mismatch"],
    ["channel_order_currency_mismatch", "money_mismatch"],
    ["channel_order_missing_settlement_evidence", "money_mismatch"],
    ["channel_order_unmapped_sellable", "unmapped_sellable"],
    ["channel_order_unsupported_sellable_kind", "unmapped_sellable"],
    ["channel_order_vat_unresolvable", "vat_unresolvable"],
    ["channel_order_unsupported_contract_version", "contract_parse_failed"],
  ])("files %s as %s", (raised, reason) => {
    expect(classifyQuarantineReason(new Error(raised))).toBe(reason);
  });

  it("reads the raised name out of a store-wrapped message", () => {
    expect(
      classifyQuarantineReason(
        new Error("commerce_create_channel_order_failed: channel_order_vat_unresolvable"),
      ),
    ).toBe("vat_unresolvable");
  });

  it("reads a raised name carried in the details of a postgrest-shaped error", () => {
    expect(
      classifyQuarantineReason({ message: "rpc failed", details: "channel_order_unmapped_sellable" }),
    ).toBe("unmapped_sellable");
  });

  it.each([
    ["a dropped connection", new Error("Connection terminated unexpectedly")],
    ["a serialization failure", new Error("could not serialize access due to concurrent update")],
    ["a permission error", new Error("permission denied for function")],
    ["a deadlock", new Error("deadlock detected")],
    ["nothing at all", null],
    ["an empty object", {}],
  ])("returns null for %s, so it stays retryable", (_label, error) => {
    expect(classifyQuarantineReason(error)).toBeNull();
  });

  it("names the parse failure the connector could not get past at all", () => {
    expect(contractParseQuarantine()).toBe("contract_parse_failed");
  });

  it("prefers the far side's own token when one was supplied", () => {
    expect(quarantineVocabulary(new Error("channel_order_unmapped_sellable"), " SKU-9 ")).toBe(
      "SKU-9",
    );
  });

  it("falls back to the raised name only when the payload named no token", () => {
    expect(quarantineVocabulary(new Error("channel_order_vat_unresolvable"), null)).toBe(
      "channel_order_vat_unresolvable",
    );
    expect(quarantineVocabulary(new Error("channel_order_vat_unresolvable"), "  ")).toBe(
      "channel_order_vat_unresolvable",
    );
  });

  it("says unknown rather than inventing a token for an unrecognised failure", () => {
    expect(quarantineVocabulary(new Error("something else entirely"), null)).toBe("unknown");
  });
});
