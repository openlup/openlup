import { describe, expect, it, vi } from "vitest";

import type { ShipmentSpineMutationPort } from "../../../src/domains/fulfillment/commerceFulfillmentPorts.js";
import { resolveShipmentSpineBinding } from "./shipmentSpineBinding.js";

const RESULT = {
  shipmentId: "11111111-1111-4111-8111-111111111111",
  orderId: "22222222-2222-4222-8222-222222222222",
  status: "created",
  replayed: false,
};

describe("shipment spine binding", () => {
  it("refuses direct PostgreSQL before constructing a lane when DATABASE_URL is absent", () => {
    const createPostgresLane = vi.fn();
    const createPostgresPort = vi.fn();

    expect(resolveShipmentSpineBinding(
      { PLATFORM_BUNDLE: "node-postgres", FULFILLMENT_PORT_KEY: "opaque-port" },
      { createPostgresLane, createPostgresPort: createPostgresPort as never },
    )).toEqual({ error: "database_url_required" });
    expect(createPostgresLane).not.toHaveBeenCalled();
    expect(createPostgresPort).not.toHaveBeenCalled();
  });

  it("refuses direct PostgreSQL before constructing a lane when the opaque port key is absent", () => {
    const createPostgresLane = vi.fn();

    expect(resolveShipmentSpineBinding(
      { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: "postgres://platform" },
      { createPostgresLane },
    )).toEqual({ error: "fulfillment_port_key_required" });
    expect(createPostgresLane).not.toHaveBeenCalled();
  });

  it("runs the direct adapter in its capability-local lane and honors the explicit port override", async () => {
    const query = vi.fn();
    const close = vi.fn().mockResolvedValue(undefined);
    const run = async <T>(work: (client: unknown) => Promise<T>): Promise<T> => work({ query });
    const port = spinePort();
    const createPostgresPort = vi.fn(() => port);
    const createPostgresLane = vi.fn(() => ({ run, close }));
    const resolved = resolveShipmentSpineBinding(
      {
        PLATFORM_BUNDLE: "node-postgres",
        DATABASE_URL: "postgres://platform",
        FULFILLMENT_PORT_KEY: "env-port",
      },
      {
        portKey: " option-port ",
        requiredProviderType: "simulator",
        createPostgresLane,
        createPostgresPort: createPostgresPort as never,
      },
    );

    expect(resolved.error).toBeUndefined();
    expect(createPostgresLane).toHaveBeenCalledWith("postgres://platform");
    expect(createPostgresPort).not.toHaveBeenCalled();
    await expect(resolved.binding?.createShipment({
      idempotencyKey: "shipment-create-1",
      orderId: RESULT.orderId,
    })).resolves.toEqual(RESULT);
    expect(createPostgresPort).toHaveBeenCalledWith({ query }, {
      portKey: "option-port",
      requiredProviderType: "simulator",
    });
    expect(port.createShipment).toHaveBeenCalledWith({
      idempotencyKey: "shipment-create-1",
      orderId: RESULT.orderId,
    });
    await resolved.binding?.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("uses FULFILLMENT_PORT_KEY when no explicit override is supplied", async () => {
    const port = spinePort();
    const createPostgresPort = vi.fn(() => port);
    const resolved = resolveShipmentSpineBinding(
      {
        PLATFORM_BUNDLE: "node-postgres",
        DATABASE_URL: "postgres://platform",
        FULFILLMENT_PORT_KEY: " env-port ",
      },
      {
        createPostgresLane: () => ({
          run: (work) => work({ query: vi.fn() }),
          close: vi.fn().mockResolvedValue(undefined),
        }),
        createPostgresPort: createPostgresPort as never,
      },
    );

    await resolved.binding?.cancel({
      idempotencyKey: "shipment-cancel-1",
      shipmentId: RESULT.shipmentId,
      reason: "operator request",
    });
    expect(createPostgresPort).toHaveBeenCalledWith(expect.any(Object), {
      portKey: "env-port",
      requiredProviderType: undefined,
    });
  });

  it("returns named managed refusals instead of a null or placeholder port", () => {
    const createManagedPort = vi.fn();

    expect(resolveShipmentSpineBinding(
      { PLATFORM_BUNDLE: "node-supabase" },
      { createManagedPort: createManagedPort as never },
    )).toEqual({ error: "fulfillment_managed_client_required" });
    expect(resolveShipmentSpineBinding(
      { PLATFORM_BUNDLE: "node-supabase" },
      { managedClient: {} as never, createManagedPort: createManagedPort as never },
    )).toEqual({ error: "fulfillment_provider_kind_required" });
    expect(createManagedPort).not.toHaveBeenCalled();
  });

  it("binds the injected managed RPC client and provider identity without opening PostgreSQL", async () => {
    const managedClient = { rpc: vi.fn() };
    const port = spinePort();
    const createManagedPort = vi.fn(() => port);
    const createPostgresLane = vi.fn();
    const createPostgresPort = vi.fn();
    const resolved = resolveShipmentSpineBinding(
      { PLATFORM_BUNDLE: "vercel-supabase" },
      {
        managedClient: managedClient as never,
        providerKind: " managed-provider ",
        createManagedPort: createManagedPort as never,
        createPostgresLane,
        createPostgresPort: createPostgresPort as never,
      },
    );

    expect(resolved.error).toBeUndefined();
    expect(createManagedPort).toHaveBeenCalledWith(managedClient, { providerKind: "managed-provider" });
    await expect(resolved.binding?.handOff({
      idempotencyKey: "shipment-handoff-1",
      shipmentId: RESULT.shipmentId,
    })).resolves.toEqual(RESULT);
    await expect(resolved.binding?.close()).resolves.toBeUndefined();
    expect(createPostgresLane).not.toHaveBeenCalled();
    expect(createPostgresPort).not.toHaveBeenCalled();
  });
});

function spinePort(): ShipmentSpineMutationPort {
  return {
    createShipment: vi.fn(async () => RESULT),
    recordLabel: vi.fn(async () => RESULT),
    handOff: vi.fn(async () => RESULT),
    recordTracking: vi.fn(async () => RESULT),
    cancel: vi.fn(async () => RESULT),
    raiseException: vi.fn(async () => RESULT),
  };
}
