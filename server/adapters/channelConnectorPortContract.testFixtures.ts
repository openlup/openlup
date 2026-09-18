// Shared ChannelConnectorPort contract — the eight scenarios every channel connector must satisfy.
//
// The SAME assertion set runs against any connector that can be exercised with a fake or file-backed
// far side. It stays app-side rather than in public core because the connector port still carries
// this repo's wire contract; exporting it from core would make that coupling look neutral.
// `.testFixtures.ts` keeps vitest from collecting this as a standalone suite.
//
// The eight are not a wish list. Each one pins a mistake that has actually been made by a provider
// integration in this repository, or that the wire contract exists specifically to prevent.

import { describe, expect, it } from "vitest";

import { normalizedChannelOrderSchema } from "../../src/domains/channels/orderContracts.js";
import { CHANNEL_ORDER_PAID_EXTERNALLY_STATE } from "../../src/domains/channels/orderContracts.js";
import type { ChannelConnectorPort } from "../../src/domains/channels/ports.js";
import { channelConnectorCapabilityViolations } from "../domains/channels/channelConnectorRegistry.js";

export interface ChannelConnectorContractSubject {
  name: string;
  createSubject: () => ChannelConnectorPort;
  /** Headers and body that normalize to exactly one order. */
  orderWebhook: { headers: Record<string, string>; rawBody: string };
  /** Headers and body carrying a wire token the connector cannot map. */
  unmappedWebhook: { headers: Record<string, string>; rawBody: string };
  /** A connection reference the pull path accepts. */
  connectionRef: string;
  /**
   * Every fixture path this subject reads from disk. Non-empty is the assertion: a connector whose
   * scenarios are inlined in TypeScript cannot be edited to reproduce a real payload.
   */
  fixtureFiles: readonly string[];
}

export function describeChannelConnectorPortContract(subject: ChannelConnectorContractSubject): void {
  const signal = () => new AbortController().signal;

  describe(`ChannelConnectorPort contract: ${subject.name}`, () => {
    // B3. The refusal that keeps one unknown token from taking a whole delivery down. Every
    // marketplace adds enum values without warning; a connector that throws on the first unfamiliar
    // one turns a routine vocabulary change into an outage.
    it("returns an unknown wire token as unmapped instead of throwing (webhook)", async () => {
      const result = await subject.createSubject().orders.normalizeWebhook({
        ...subject.unmappedWebhook,
        signal: signal(),
      });

      expect(result.kind).toBe("unmapped");
      if (result.kind !== "unmapped") return;
      expect(result.signal.vocabulary.trim()).not.toBe("");
      // The WIRE token, not a label: an operator has to be able to search the far side's own docs.
      expect(result.signal.vocabulary).toBe(result.signal.vocabulary.trim());
    });

    it("surfaces unmapped signals from the pull path instead of dropping them", async () => {
      const port = subject.createSubject();
      if (!port.capabilities.supportsOrderPull) return;

      const pulled = await port.orders.pullOrders({
        connectionRef: subject.connectionRef,
        channelExternalRef: null,
        since: null,
        cursor: null,
        limit: 50,
        signal: signal(),
      });

      expect(Array.isArray(pulled.unmapped)).toBe(true);
      expect(pulled.unmapped.length).toBeGreaterThan(0);
    });

    // B4. Correlation honesty. The descriptor is a promise about which wire fields exist; a
    // descriptor that names a customer field the payloads never carry sends the ingest saga looking
    // for a stable identity that is not there, and it silently merges or splits buyers.
    it("keeps its declared correlation contract true of the orders it emits", async () => {
      const port = subject.createSubject();
      const result = await port.orders.normalizeWebhook({
        ...subject.orderWebhook,
        signal: signal(),
      });

      expect(result.kind).toBe("order");
      if (result.kind !== "order") return;
      const { correlation } = port.capabilities;

      // The order correlation key is never null, by contract.
      expect(result.order.externalOrderRef.trim()).not.toBe("");
      expect(correlation.orderRefField.trim()).not.toBe("");

      if (correlation.customerRefField === null) {
        // Declared: no stable buyer identity exists on this platform. Then none may be emitted.
        expect(result.order.buyer.externalCustomerRef).toBeNull();
      }
      if (correlation.emailIsAlwaysMasked) {
        expect(result.order.buyer.emailIsMasked).toBe(true);
      }
    });

    // B5. Redelivery. The dedupe key must be a function of the ORDER, not of the delivery: an id
    // derived from a timestamp or a retry counter makes every redelivery a new event, and every new
    // event a second order.
    it("emits a byte-identical provider event id on an exact redelivery", async () => {
      const port = subject.createSubject();
      const first = await port.orders.normalizeWebhook({ ...subject.orderWebhook, signal: signal() });
      const second = await port.orders.normalizeWebhook({ ...subject.orderWebhook, signal: signal() });

      expect(first.kind).toBe("order");
      expect(second.kind).toBe("order");
      if (first.kind !== "order" || second.kind !== "order") return;
      expect(second.providerEventId).toBe(first.providerEventId);
      expect(second.order).toEqual(first.order);
    });

    // Money. The identities are enforced by the wire schema, so this asserts the connector's output
    // actually goes through it rather than around it.
    it("emits orders whose money identities hold", async () => {
      const result = await subject.createSubject().orders.normalizeWebhook({
        ...subject.orderWebhook,
        signal: signal(),
      });
      if (result.kind !== "order") throw new Error("expected an order");

      expect(() => normalizedChannelOrderSchema.parse(result.order)).not.toThrow();
      const { totals } = result.order;
      expect(totals.grandTotalMinor).toBe(
        totals.itemsGrossMinor -
          totals.itemsDiscountMinor +
          totals.shippingGrossMinor -
          totals.shippingDiscountMinor,
      );
    });

    // Settlement evidence. An order claiming the money was collected elsewhere, with no reference to
    // that collection, is an order nobody can ever reconcile or refund.
    it("carries non-blank settlement evidence whenever it reports an external payment", async () => {
      const result = await subject.createSubject().orders.normalizeWebhook({
        ...subject.orderWebhook,
        signal: signal(),
      });
      if (result.kind !== "order") throw new Error("expected an order");

      if (result.order.payment.state !== CHANNEL_ORDER_PAID_EXTERNALLY_STATE) return;
      expect(result.order.payment.externalPaymentRef.trim()).not.toBe("");
      expect(result.order.payment.paidAt.trim()).not.toBe("");
    });

    // Capability honesty, in both directions. A declared sub-port that is absent resolves to
    // undefined at the call site; an undeclared sub-port that is present is a capability nothing
    // will ever route to.
    it("declares exactly the sub-ports it carries", () => {
      expect(channelConnectorCapabilityViolations(subject.createSubject())).toEqual([]);
    });

    // Fixtures from files. A connector whose scenarios only exist as TypeScript literals cannot be
    // handed a real captured payload without a code change.
    it("loads its scenarios from files rather than from inlined literals", () => {
      expect(subject.fixtureFiles.length).toBeGreaterThan(0);
      for (const file of subject.fixtureFiles) {
        expect(file.endsWith(".json")).toBe(true);
      }
    });
  });
}
