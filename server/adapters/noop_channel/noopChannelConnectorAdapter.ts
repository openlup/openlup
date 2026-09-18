import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  normalizedChannelOrderSchema,
  unmappedChannelSignalSchema,
  type NormalizedChannelOrder,
  type UnmappedChannelSignal,
} from "../../../src/domains/channels/orderContracts.js";
import type {
  ChannelBinding,
  ChannelConnectorCapabilities,
  ChannelConnectorPort,
  NormalizedWebhookResult,
} from "../../../src/domains/channels/ports.js";

// The simulator connector: a real implementation of the connector port whose far side is a
// directory of files.
//
// It exists so the ingest saga can be driven end to end before any marketplace exists, and so the
// contract fixtures have a THIRD subject that is not one of the shipped integrations. Its fixtures
// are LOADED FROM FILES rather than inlined, deliberately: a fixture that lives in a .json file is
// one an operator can edit to reproduce a real payload, and one that cannot quietly drift with the
// code that reads it.
//
// It settles nothing and charges nothing. Admission refuses it wherever a simulated settlement must
// not be believed; that refusal, not this file, is what keeps it out of production.

export const NOOP_CHANNEL_CONNECTOR_KIND = "noop_channel";

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export const noopChannelCapabilities: ChannelConnectorCapabilities = {
  connectorKind: NOOP_CHANNEL_CONNECTOR_KIND,
  // One connection is one surface: the simplest shape, and the one that proves the port does not
  // need the aggregator fan-out to be useful.
  connectorShape: "direct",
  supportsChannelDiscovery: true,
  supportsOrderPull: true,
  supportsOrderWebhook: true,
  supportsOrderAck: true,
  // Declared false and NOT implemented, which is the point: capability honesty is a frozen
  // scenario, so these four must stay exactly as absent as they claim to be.
  supportsListingLink: false,
  supportsStockPush: false,
  supportsPricePush: false,
  supportsShipmentPush: false,
  correlation: {
    orderRefField: "externalOrderRef",
    customerRefField: "buyer.externalCustomerRef",
    // The fixtures carry a stable buyer reference, so a null one would mean this platform has no
    // stable identity at all — not that this order happens to lack one.
    customerRefNullMeans: "per_order_identity",
    emailIsAlwaysMasked: true,
  },
};

export interface NoopChannelConnectorOptions {
  /** Overrides the fixture directory; the contract suite points it at its own copies. */
  fixtureDir?: string;
}

export function readChannelOrderFixture(
  name: string,
  options: NoopChannelConnectorOptions = {},
): NormalizedChannelOrder {
  const raw = JSON.parse(readFileSync(join(options.fixtureDir ?? FIXTURE_DIR, name), "utf8"));
  // Parsed through the wire contract rather than cast. A fixture that no longer satisfies
  // `channel.order.v1` must fail here, loudly, instead of travelling as a lie about the contract.
  return normalizedChannelOrderSchema.parse(raw);
}

export function readUnmappedSignalFixture(
  name: string,
  options: NoopChannelConnectorOptions = {},
): UnmappedChannelSignal {
  const raw = JSON.parse(readFileSync(join(options.fixtureDir ?? FIXTURE_DIR, name), "utf8"));
  return unmappedChannelSignalSchema.parse(raw);
}

export function listChannelOrderFixtures(options: NoopChannelConnectorOptions = {}): string[] {
  return readdirSync(options.fixtureDir ?? FIXTURE_DIR)
    .filter((entry) => entry.startsWith("order-") && entry.endsWith(".json"))
    .sort();
}

export function createNoopChannelConnectorAdapter(
  options: NoopChannelConnectorOptions = {},
): ChannelConnectorPort {
  const bindings: ChannelBinding[] = [
    {
      channelExternalRef: "surface-1",
      displayName: "Simulator surface",
      marketplaceHint: null,
      // Declared by the operator on the channel row, not invented by the connector.
      currency: null,
      regionCode: null,
    },
  ];

  return {
    capabilities: noopChannelCapabilities,
    orders: {
      async listChannelBindings() {
        return bindings;
      },

      async pullOrders(input) {
        // A cursor that has already been through the fixtures returns nothing, so a poll loop
        // driving this connector terminates rather than re-delivering forever.
        if (input.cursor === "end") {
          return { orders: [], unmapped: [], nextCursor: null, watermarkAt: null };
        }
        const orders = listChannelOrderFixtures(options)
          // The redelivery fixture is byte-identical to the well-formed one and is served by the
          // webhook path; pulling it too would make a pull look like it produced a duplicate.
          .filter((name) => name !== "order-redelivery.json")
          .map((name) => readChannelOrderFixture(name, options));
        return {
          orders,
          // Surfaced, never dropped: the unknown-vocabulary signal rides out of the same call.
          unmapped: [readUnmappedSignalFixture("signal-unknown-vocabulary.json", options)],
          nextCursor: "end",
          watermarkAt: "2026-08-12T10:05:00Z",
        };
      },

      async normalizeWebhook(input): Promise<NormalizedWebhookResult> {
        if (input.headers["x-simulator-signature"] !== "valid") {
          // Fails closed on the signature, before the body is looked at.
          return { kind: "rejected", reason: "signature" };
        }

        let parsed: { fixture?: unknown };
        try {
          parsed = JSON.parse(input.rawBody) as { fixture?: unknown };
        } catch {
          return { kind: "rejected", reason: "malformed" };
        }

        const fixture = typeof parsed.fixture === "string" ? parsed.fixture : "";
        if (fixture === "signal-unknown-vocabulary.json") {
          const signal = readUnmappedSignalFixture(fixture, options);
          // NEVER thrown. An unknown wire token is data this connector could not map, not an error
          // it should raise: raising would take the whole delivery down with it.
          return { kind: "unmapped", providerEventId: `sim-evt-${signal.vocabulary}`, signal };
        }
        if (!fixture.startsWith("order-") || !fixture.endsWith(".json")) {
          return { kind: "ignored", providerEventId: "sim-evt-ignored", reason: "not_an_order" };
        }

        const order = readChannelOrderFixture(fixture, options);
        // The event id comes from the ORDER, not from the delivery, which is what makes a
        // redelivery of the same order carry a byte-identical id.
        return { kind: "order", providerEventId: order.providerEventId, order };
      },

      async acknowledgeOrder(input) {
        return { acknowledged: true, detail: { externalOrderRef: input.externalOrderRef } };
      },
    },
  };
}
