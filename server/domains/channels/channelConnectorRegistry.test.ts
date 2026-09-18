import { describe, expect, it } from "vitest";

import {
  channelConnectorCapabilityViolations,
  getChannelConnector,
  isSimulatedChannelConnector,
  SimulatedChannelConnectorNotAllowedError,
  UnknownChannelConnectorError,
} from "./channelConnectorRegistry.js";
import { createNoopChannelConnectorAdapter } from "../../adapters/noop_channel/noopChannelConnectorAdapter.js";
import type { ChannelConnectorPort } from "../../../src/domains/channels/ports.js";

const simulator = createNoopChannelConnectorAdapter();

describe("channel connector registry", () => {
  it("returns an injected connector", () => {
    expect(getChannelConnector("noop_channel", { noop_channel: simulator }, true)).toBe(simulator);
  });

  it("refuses a simulator where simulated settlement is forbidden, even when injected", () => {
    expect(() => getChannelConnector("noop_channel", { noop_channel: simulator }, false)).toThrow(
      SimulatedChannelConnectorNotAllowedError,
    );
  });

  it("reports a permitted-but-unregistered simulator as unknown rather than constructing one", () => {
    expect(() => getChannelConnector("noop_channel", {}, true)).toThrow(UnknownChannelConnectorError);
  });

  it("reports an unrecognised connector kind as unknown", () => {
    expect(() => getChannelConnector("some_marketplace", {}, false)).toThrow(
      UnknownChannelConnectorError,
    );
  });

  it("refuses an injected connector whose capabilities are dishonest", () => {
    const dishonest: ChannelConnectorPort = {
      ...simulator,
      capabilities: { ...simulator.capabilities, supportsStockPush: true },
    };

    expect(() => getChannelConnector("noop_channel", { noop_channel: dishonest }, true)).toThrow(
      /channel_connector_capability_dishonest/,
    );
  });

  it("names only the simulator kinds as simulated", () => {
    expect(isSimulatedChannelConnector("noop_channel")).toBe(true);
    expect(isSimulatedChannelConnector("some_marketplace")).toBe(false);
  });

  it("catches an undeclared sub-port that is present, not only a declared one that is absent", () => {
    const undeclared: ChannelConnectorPort = {
      ...simulator,
      shipments: {
        async pushShipment() {
          return { accepted: true, externalShipmentRef: null };
        },
      },
    };

    expect(channelConnectorCapabilityViolations(undeclared)).toEqual([
      "shipments: declared false, present true",
    ]);
  });

  it("carries the offending kind on both refusals", () => {
    try {
      getChannelConnector("noop_channel", {}, false);
    } catch (error) {
      expect(error).toBeInstanceOf(SimulatedChannelConnectorNotAllowedError);
      expect((error as SimulatedChannelConnectorNotAllowedError).connectorKind).toBe("noop_channel");
    }
    try {
      getChannelConnector("mystery", {}, true);
    } catch (error) {
      expect((error as UnknownChannelConnectorError).connectorKind).toBe("mystery");
    }
  });
});
