import { describe, expect, it, vi } from "vitest";

import {
  createChannelWebhookPort,
  resolveChannelConnectors,
  resolveChannelOrderSource,
} from "./channelIngestComposition.js";
import { ChannelIngestUnavailableError } from "../../domains/channels/channelWebhookHandler.js";
import {
  SimulatedChannelConnectorNotAllowedError,
  UnknownChannelConnectorError,
} from "../../domains/channels/channelConnectorRegistry.js";
import { readUnmappedSignalFixture } from "../../adapters/noop_channel/noopChannelConnectorAdapter.js";
import type { ChannelIngestStorePort } from "../../../src/domains/channels/channelIngestStorePort.js";
import { PLATFORM_ACCEPTED_CURRENCIES } from "../../../src/lib/currency/platformCurrency.js";

function store(): ChannelIngestStorePort {
  return {
    recordInboundEvent: vi.fn(),
    upsertBuyer: vi.fn(),
    createChannelOrder: vi.fn(),
    advanceLedger: vi.fn(),
    quarantine: vi.fn(async () => ({
      id: "quar-1",
      reason: "unmapped_vocabulary" as const,
      status: "open" as const,
      vocabulary: "SUPER_SAVER",
    })),
  } as unknown as ChannelIngestStorePort;
}

describe("channel ingest composition", () => {
  it("offers the simulator only where a simulated settlement may be believed", () => {
    expect(Object.keys(resolveChannelConnectors(true))).toEqual(["noop_channel"]);
    expect(Object.keys(resolveChannelConnectors(false))).toEqual([]);
  });

  it("refuses the simulator kind outright where simulation is forbidden", () => {
    expect(() => resolveChannelOrderSource("noop_channel", false)).toThrow(
      SimulatedChannelConnectorNotAllowedError,
    );
  });

  it("refuses a connector kind nothing composed", () => {
    expect(() => resolveChannelOrderSource("some_marketplace", true)).toThrow(UnknownChannelConnectorError);
  });

  it("resolves the simulator's order source where simulation is allowed", () => {
    expect(typeof resolveChannelOrderSource("noop_channel", true).normalizeWebhook).toBe("function");
  });

  it("files an unmapped signal in the drawer with unattributed ownership and the wire token verbatim", async () => {
    const backing = store();
    const signal = readUnmappedSignalFixture("signal-unknown-vocabulary.json");

    const filed = await createChannelWebhookPort({
      store: backing,
      acceptedCurrencies: PLATFORM_ACCEPTED_CURRENCIES,
      noopSettlementForbidden: false,
    }).quarantineSignal({ providerEventId: "sim-evt-1", signal });

    expect(filed).toEqual({ quarantineId: "quar-1" });
    expect(backing.quarantine).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: null,
        connectionId: null,
        providerEventId: "sim-evt-1",
        vocabulary: signal.vocabulary,
        reason: "unmapped_vocabulary",
      }),
    );
  });

  it("names a missing channel read and a missing rail slot separately", async () => {
    const withoutChannels = createChannelWebhookPort({
      store: store(),
      acceptedCurrencies: PLATFORM_ACCEPTED_CURRENCIES,
      noopSettlementForbidden: false,
    });
    await expect(withoutChannels.ingestOrder({} as never)).rejects.toMatchObject({
      name: "ChannelIngestUnavailableError",
      reason: "channel_read_unavailable",
    });

    const withoutRails = createChannelWebhookPort({
      store: store(),
      channels: { readChannelBySlug: vi.fn() },
      acceptedCurrencies: PLATFORM_ACCEPTED_CURRENCIES,
      noopSettlementForbidden: false,
    });
    await expect(withoutRails.ingestOrder({} as never)).rejects.toBeInstanceOf(ChannelIngestUnavailableError);
    await expect(withoutRails.ingestOrder({} as never)).rejects.toMatchObject({
      reason: "channel_ingest_rails_unbound",
    });
  });

  it("writes nothing when a rail is unbound", async () => {
    const backing = store();

    await createChannelWebhookPort({
      store: backing,
      acceptedCurrencies: PLATFORM_ACCEPTED_CURRENCIES,
      noopSettlementForbidden: false,
    })
      .ingestOrder({} as never)
      .catch(() => undefined);

    expect(backing.recordInboundEvent).not.toHaveBeenCalled();
    expect(backing.createChannelOrder).not.toHaveBeenCalled();
  });
});
