import type { ChannelConnectorPort } from "../../../src/domains/channels/ports.js";
import { NOOP_CHANNEL_CONNECTOR_KINDS } from "./channelIngestAdmission.js";

// Provider-neutral selection of a channel connector, in the same three-branch shape the payment
// adapter registry uses: an injected adapter wins, a simulator resolves only where simulation is
// allowed, and anything else is an unknown kind rather than a silent no-op.
//
// House doctrine, restated because it is easy to lose: the connector PORT is not a framework. This
// is a switch over a map composition supplies, not a plugin loader, not a manifest format, and not
// a place a second connector registers itself. It stays this small until a second real connector
// implementation exists.

export class UnknownChannelConnectorError extends Error {
  readonly connectorKind: string;

  constructor(connectorKind: string) {
    super(`Unknown channel connector: ${connectorKind}`);
    this.name = "UnknownChannelConnectorError";
    this.connectorKind = connectorKind;
  }
}

export class SimulatedChannelConnectorNotAllowedError extends Error {
  readonly connectorKind: string;

  constructor(connectorKind: string) {
    super(`Simulated channel connector is not allowed here: ${connectorKind}`);
    this.name = "SimulatedChannelConnectorNotAllowedError";
    this.connectorKind = connectorKind;
  }
}

export function isSimulatedChannelConnector(connectorKind: string): boolean {
  return NOOP_CHANNEL_CONNECTOR_KINDS.includes(connectorKind);
}

export function getChannelConnector(
  connectorKind: string,
  injectedConnectors: Record<string, ChannelConnectorPort>,
  simulatorAllowed: boolean,
): ChannelConnectorPort {
  // The forbidden check comes FIRST, before the injection lookup. Injecting a simulator is exactly
  // how one would reach production by accident, so being injected must not be a way past this.
  if (!simulatorAllowed && isSimulatedChannelConnector(connectorKind)) {
    throw new SimulatedChannelConnectorNotAllowedError(connectorKind);
  }

  const injected = injectedConnectors[connectorKind];
  if (injected) {
    // Capability honesty is checked at the seam a connector actually enters through, not only in
    // the contract suite: a descriptor that claims a sub-port it does not carry would send the
    // saga down a branch that resolves to undefined at runtime.
    assertCapabilityHonesty(injected);
    return injected;
  }

  // A simulator kind that is permitted but not injected is simply not registered here. There is no
  // implicit construction: a connector this registry did not receive is one composition did not
  // choose, and inventing one would be the same mistake in a smaller box.
  throw new UnknownChannelConnectorError(connectorKind);
}

/** `supportsX === (subPort !== undefined)`, in both directions, for every optional sub-port. */
export function channelConnectorCapabilityViolations(
  connector: ChannelConnectorPort,
): readonly string[] {
  const { capabilities } = connector;
  const pairs: readonly [string, boolean, boolean][] = [
    ["listings", capabilities.supportsListingLink, connector.listings !== undefined],
    ["stockPrice.stock", capabilities.supportsStockPush, connector.stockPrice !== undefined],
    ["stockPrice.price", capabilities.supportsPricePush, connector.stockPrice !== undefined],
    ["shipments", capabilities.supportsShipmentPush, connector.shipments !== undefined],
  ];

  return pairs
    .filter(([, declared, present]) => declared !== present)
    .map(([name, declared, present]) => `${name}: declared ${declared}, present ${present}`);
}

function assertCapabilityHonesty(connector: ChannelConnectorPort): void {
  const violations = channelConnectorCapabilityViolations(connector);
  if (violations.length === 0) return;
  throw new Error(
    `channel_connector_capability_dishonest: ${connector.capabilities.connectorKind} (${violations.join("; ")})`,
  );
}
