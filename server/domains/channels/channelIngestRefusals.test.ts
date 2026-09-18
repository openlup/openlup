import { describe, expect, it, vi } from "vitest";
import {
  fileBundleRefusal,
  quarantineOrderRefusal,
  readMessage,
} from "./channelIngestRefusals.js";
import type { ChannelIngestStorePort } from "../../../src/domains/channels/channelIngestStorePort.js";

function store() {
  const quarantine = vi.fn(async () => ({
    id: "q-1",
    reason: "unmapped_sellable" as const,
    status: "open" as const,
    vocabulary: "starter",
  }));
  const advanceLedger = vi.fn(async () => ({ id: "ledger-1" }) as never);
  return {
    port: { quarantine, advanceLedger } as unknown as ChannelIngestStorePort,
    quarantine,
    advanceLedger,
  };
}

const order = {
  providerEventId: "evt-1",
  externalOrderRef: "EXT-1",
  totals: { grandTotalMinor: 1700 },
  lines: [{ sellable: { kind: "bundle", bundleCode: "starter", externalOfferRef: "OFFER-1" } }],
} as never;

const channel = { id: "channel-1", connectionId: "connection-1" };

describe("channel ingest refusals", () => {
  it("files a decided refusal and halts the ledger in the same call", async () => {
    const { port, quarantine, advanceLedger } = store();
    const outcome = await fileBundleRefusal(port, {
      order,
      channel,
      ledgerId: "ledger-1",
      refusal: { kind: "unmapped_sellable", vocabulary: "starter", detail: "not sellable today" },
    });

    expect(outcome).toEqual({
      kind: "quarantined",
      ledgerId: "ledger-1",
      reason: "unmapped_sellable",
      detail: "not sellable today",
    });
    expect(quarantine).toHaveBeenCalledWith(
      expect.objectContaining({ vocabulary: "starter", reason: "unmapped_sellable" }),
    );
    // The halt is not optional: a drawer row without it leaves the run looking live.
    expect(advanceLedger).toHaveBeenCalledWith(
      expect.objectContaining({ toStatus: "quarantined", lastError: "not sellable today" }),
    );
  });

  it("classifies a store refusal and files it under the far side's own token", async () => {
    const { port, quarantine } = store();
    const outcome = await quarantineOrderRefusal(port, {
      order,
      channel,
      ledgerId: "ledger-1",
      error: new Error("channel_order_unmapped_sellable"),
    });

    expect(outcome.reason).toBe("unmapped_sellable");
    expect(quarantine).toHaveBeenCalledWith(expect.objectContaining({ vocabulary: "starter" }));
  });

  // The rethrow is the whole point: a transient fault must stay in the retry path.
  it("rethrows anything that is not a named refusal instead of filing operator work", async () => {
    const { port, quarantine } = store();
    await expect(
      quarantineOrderRefusal(port, {
        order,
        channel,
        ledgerId: "ledger-1",
        error: new Error("connection terminated unexpectedly"),
      }),
    ).rejects.toThrow(/connection terminated/);
    expect(quarantine).not.toHaveBeenCalled();
  });

  it("reads a message off whatever the rail threw", () => {
    expect(readMessage(new Error("boom"))).toBe("boom");
    expect(readMessage("boom")).toBe("boom");
    expect(readMessage(undefined)).toBe("unknown error");
  });
});
