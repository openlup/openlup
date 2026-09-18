import { describe, expect, it } from "vitest";

import {
  admitChannelOrder,
  NoopChannelSettlementNotAllowedError,
  NOOP_CHANNEL_CONNECTOR_KINDS,
} from "./channelIngestAdmission.js";
import { readChannelOrderFixture } from "../../adapters/noop_channel/noopChannelConnectorAdapter.js";
import type { ChannelIngestChannelRecord } from "../../../src/domains/channels/channelIngestStorePort.js";
import { PLATFORM_DEFAULT_CURRENCY } from "../../../src/lib/currency/platformCurrency.js";

const channel = (overrides: Partial<ChannelIngestChannelRecord> = {}): ChannelIngestChannelRecord => ({
  id: "ca-1",
  connectionId: "c-1",
  slug: "sim-market",
  status: "active",
  currency: "EUR",
  connectorProviderKind: "noop_channel",
  settlementProviderKind: "channel_settlement",
  buyerCommsOwner: "channel",
  // A surface that has said how it ships, because every case below this one is about something
  // else. The undeclared case supplies its own override, so the refusal cannot pass by accident.
  deliverySelection: { providerKind: "simulator", kind: "courier" },
  ...overrides,
});

const order = () => readChannelOrderFixture("order-well-formed.json");

// THE FIXTURE IS EUR AND STAYS EUR. Every case below that is not about the acceptance list injects
// an accepted set that CONTAINS the fixture's currency, so each one keeps proving exactly what it
// proved before: the admission rail itself is currency-agnostic, and the only thing narrowing it is
// a list a composition root hands in. Re-baselining these fixtures to the platform's own currency
// would quietly convert this file from a proof of neutrality into a pin of today's single answer.
const ACCEPTS_EUR: readonly string[] = ["EUR"];

/**
 * What a real deployment of this platform settles today, taken from the platform module rather
 * than spelled here: the refusal cases below then prove that the CURRENT configuration turns the
 * EUR fixture away, instead of proving it against a currency invented for the test.
 */
const PLATFORM_TODAY: readonly string[] = [PLATFORM_DEFAULT_CURRENCY];

describe("channel ingest admission", () => {
  it("admits a paid-externally order on an active channel in the channel's currency", () => {
    const result = admitChannelOrder({
      order: order(),
      channel: channel(),
      acceptedCurrencies: ACCEPTS_EUR,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ admitted: true });
  });

  it("admits a channel in testing, because that status exists to be driven", () => {
    const result = admitChannelOrder({
      order: order(),
      channel: channel({ status: "testing" }),
      acceptedCurrencies: ACCEPTS_EUR,
      noopSettlementForbidden: false,
    });

    expect(result.admitted).toBe(true);
  });

  // THE WAVE'S OWN PROOF, AND IT IS A REFUSAL RATHER THAN A DEFAULT ON PURPOSE. A surface with no
  // declared delivery selection produced, before this wave, an order that reached `paid`, acquired
  // a fulfilment row, and then never became a dispatch candidate -- silently, because the gate
  // resolves the shipping provider through that selection. Refusing before the ledger row exists
  // is what keeps that state from being reachable at all.
  it("refuses a surface that has not declared how its parcels ship", () => {
    const result = admitChannelOrder({
      order: order(),
      channel: channel({ deliverySelection: null }),
      acceptedCurrencies: ACCEPTS_EUR,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ admitted: false, refusal: "delivery_selection_undeclared" });
  });

  // Ordered after the status check and before the payment state, so a disabled surface is still
  // reported as disabled rather than as unshippable: an operator reading the refusal should be
  // told the first thing that is wrong, not the second.
  it("reports a disabled surface as disabled even when it also declares no delivery", () => {
    const result = admitChannelOrder({
      order: order(),
      channel: channel({ status: "disabled", deliverySelection: null }),
      acceptedCurrencies: ACCEPTS_EUR,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ admitted: false, refusal: "channel_not_active" });
  });

  it.each(["disabled", "sunset"])("refuses a %s channel", (status) => {
    const result = admitChannelOrder({
      order: order(),
      channel: channel({ status }),
      acceptedCurrencies: ACCEPTS_EUR,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ admitted: false, refusal: "channel_not_active" });
  });

  it("refuses an unregistered channel slug", () => {
    const result = admitChannelOrder({
      order: order(),
      channel: null,
      acceptedCurrencies: ACCEPTS_EUR,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ admitted: false, refusal: "channel_not_found" });
  });

  it("refuses any settlement state other than paid_externally", () => {
    const result = admitChannelOrder({
      order: { ...order(), payment: { ...order().payment, state: "pending" } },
      channel: channel(),
      acceptedCurrencies: ACCEPTS_EUR,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ admitted: false, refusal: "unsupported_payment_state" });
  });

  it("refuses an order whose currency disagrees with its channel", () => {
    const result = admitChannelOrder({
      order: order(),
      channel: channel({ currency: "SEK" }),
      // Both currencies are accepted here on purpose, so this case still proves a MISMATCH rather
      // than accidentally proving the acceptance check that now runs before it.
      acceptedCurrencies: ["EUR", "SEK"],
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ admitted: false, refusal: "currency_mismatch" });
  });

  it("refuses a self-consistent order in a currency this deployment does not settle", () => {
    // The live hole this gate exists to close: channel and order agree, so the mismatch check has
    // nothing to say, and before this refusal existed the ingest RPC wrote a real EUR order row.
    const result = admitChannelOrder({
      order: order(),
      channel: channel(),
      acceptedCurrencies: PLATFORM_TODAY,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ admitted: false, refusal: "currency_not_accepted" });
  });

  it("refuses an unaccepted channel currency even when the order names an accepted one", () => {
    const result = admitChannelOrder({
      order: { ...order(), currency: PLATFORM_DEFAULT_CURRENCY },
      channel: channel({ currency: "EUR" }),
      acceptedCurrencies: PLATFORM_TODAY,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ admitted: false, refusal: "currency_not_accepted" });
  });

  it("raises rather than refuses when a simulator would settle where it must not", () => {
    expect(() =>
      admitChannelOrder({
        order: order(),
        channel: channel(),
        acceptedCurrencies: ACCEPTS_EUR,
        noopSettlementForbidden: true,
      }),
    ).toThrow(NoopChannelSettlementNotAllowedError);
  });

  it("lets a real connector kind through the same forbidden gate", () => {
    const result = admitChannelOrder({
      order: order(),
      channel: channel({ connectorProviderKind: "some_real_marketplace" }),
      acceptedCurrencies: ACCEPTS_EUR,
      noopSettlementForbidden: true,
    });

    expect(result.admitted).toBe(true);
    expect(NOOP_CHANNEL_CONNECTOR_KINDS).not.toContain("some_real_marketplace");
  });

  it("checks the channel before the payment state, so a dead channel is reported as one", () => {
    const result = admitChannelOrder({
      order: { ...order(), payment: { ...order().payment, state: "pending" } },
      channel: channel({ status: "disabled" }),
      acceptedCurrencies: ACCEPTS_EUR,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ refusal: "channel_not_active" });
  });

  it("reports an unsettled payment state before an unaccepted currency", () => {
    // Order matters for triage: a delivery this wave cannot finish AND cannot price is the
    // former, because the payment state is a fact about this order while the currency is a fact
    // about the deployment's configuration.
    const result = admitChannelOrder({
      order: { ...order(), payment: { ...order().payment, state: "pending" } },
      channel: channel(),
      acceptedCurrencies: PLATFORM_TODAY,
      noopSettlementForbidden: false,
    });

    expect(result).toMatchObject({ refusal: "unsupported_payment_state" });
  });
});
