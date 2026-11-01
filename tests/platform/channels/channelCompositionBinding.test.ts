import { describe, expect, it } from "vitest";
import {
  ChannelIngestUnavailableError,
  createChannelWebhookPort,
  ingestRetainedChannelPurchase,
  type ChannelIngestPortOptions,
  type ChannelIngestRails,
} from "@openlup/platform/channels/server";
import { purchaseFixture } from "../../helpers/channelPurchaseFixture.js";

function observedOptions(reads: string[], channelsBound: boolean, railsBound: boolean): ChannelIngestPortOptions {
  const unexpected = (name: string): never => {
    reads.push(name);
    throw new Error(`Unexpected saga dependency: ${name}`);
  };
  return {
    get channels() {
      reads.push("channels");
      return channelsBound ? { readChannelBySlug: async () => unexpected("channel.read") } : undefined;
    },
    get rails() {
      reads.push("rails");
      return railsBound ? new Proxy({} as ChannelIngestRails, {
        get(_target, name) { return unexpected(`rails.${String(name)}`); },
      }) : undefined;
    },
    get store() { return unexpected("store"); },
    get acceptedCurrencies() { return unexpected("acceptedCurrencies"); },
    get noopSettlementForbidden() { return unexpected("noopSettlementForbidden"); },
  };
}

async function expectUnavailable(run: () => Promise<unknown>, reason: string) {
  const error = await run().then(() => { throw new Error("Expected unavailable refusal"); }, caught => caught);
  expect(error).toBeInstanceOf(ChannelIngestUnavailableError);
  expect(error).toMatchObject({ name: "ChannelIngestUnavailableError", reason,
    message: `Channel ingest is unavailable: ${reason}` });
}

describe.each(["webhook", "retained"] as const)("channel %s composition bindings", entry => {
  it.each([
    { channelsBound: false, reason: "channel_read_unavailable", expectedReads: ["channels"] },
    { channelsBound: true, reason: "channel_ingest_rails_unbound", expectedReads: ["channels", "rails"] },
  ])("refuses $reason in order before reading any saga dependency", async ({ channelsBound, reason, expectedReads }) => {
    const reads: string[] = [], options = observedOptions(reads, channelsBound, false);
    const { capture } = purchaseFixture();
    const run = entry === "webhook"
      ? () => createChannelWebhookPort(options).ingestOrder(capture.normalized)
      : () => ingestRetainedChannelPurchase({ capture, options, reservations: {
        async reserveChannelOrderItems() { throw new Error("Unexpected reservation effect"); },
      } });
    await expectUnavailable(run, reason);
    expect(reads).toEqual(expectedReads);
  });
});

it("reads retained options separately for both bindings, then refuses absent rows before dependency assembly", async () => {
  const reads: string[] = [];
  const first = observedOptions(reads, true, false), second = observedOptions(reads, false, true);
  const { capture } = purchaseFixture();
  Object.defineProperty(capture, "retainedRows", { get() { reads.push("retainedRows"); return undefined; } });
  let optionsReads = 0;
  await expectUnavailable(() => ingestRetainedChannelPurchase({
    capture,
    get options() { reads.push(`options:${++optionsReads}`); return optionsReads === 1 ? first : second; },
    get reservations(): ChannelIngestRails["reservations"] { reads.push("reservations"); throw new Error("Unexpected reservation binding read"); },
  }), "channel_purchase_retained_rows_unavailable");
  expect(reads).toEqual(["options:1", "channels", "options:2", "rails", "retainedRows"]);
});
