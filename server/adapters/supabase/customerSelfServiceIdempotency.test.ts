import { describe, expect, it, vi } from "vitest";

import {
  hasRecordedEvent,
  isUniqueViolation,
  mergePetMetadata,
  readOwnedPet,
  readPetByIdempotencyKey,
  runIdempotentCustomerMutation,
} from "./customerSelfServiceIdempotency.js";

describe("customer self-service idempotency helpers", () => {
  it("preserves existing pet metadata source while applying patches", () => {
    expect(mergePetMetadata(
      { source: "customer_account", configuratorPetKey: "pet-a", allergies: ["beef"] },
      { source: "ignored", idempotencyKey: "idem-1", bodyCondition: "fit" },
    )).toEqual({
      source: "customer_account",
      configuratorPetKey: "pet-a",
      allergies: ["beef"],
      idempotencyKey: "idem-1",
      bodyCondition: "fit",
    });
  });

  it("falls back to the patch source when existing metadata is not an object", () => {
    expect(mergePetMetadata(null, { source: "customer_account", idempotencyKey: "idem-1" })).toEqual({
      source: "customer_account",
      idempotencyKey: "idem-1",
    });
  });

  it("detects Postgres unique-violation errors only by code", () => {
    expect(isUniqueViolation({ code: "23505" })).toBe(true);
    expect(isUniqueViolation({ code: "PGRST116" })).toBe(false);
    expect(isUniqueViolation(null)).toBe(false);
  });

  it("checks recorded customer events by idempotency key", async () => {
    const limit = vi.fn(async () => ({ data: [{ id: "event-1" }], error: null }));
    const eq = vi.fn(() => ({ eq, limit }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    await expect(hasRecordedEvent({ from } as never, "client-1", "profile.updated", "idem-1")).resolves.toBe(true);

    expect(from).toHaveBeenCalledWith("customer_account_events");
    expect(select).toHaveBeenCalledWith("id");
    expect(eq).toHaveBeenCalledWith("client_id", "client-1");
    expect(eq).toHaveBeenCalledWith("event_type", "profile.updated");
    expect(eq).toHaveBeenCalledWith("payload->>idempotencyKey", "idem-1");
    expect(limit).toHaveBeenCalledWith(1);
  });

  it("reads pets by customer-account idempotency key", async () => {
    const row = { id: "pet-1" };
    const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    const eq = vi.fn(() => ({ eq, maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    await expect(readPetByIdempotencyKey({ from } as never, "client-1", "idem-1")).resolves.toBe(row);

    expect(from).toHaveBeenCalledWith("pets");
    expect(eq).toHaveBeenCalledWith("client_id", "client-1");
    expect(eq).toHaveBeenCalledWith("metadata->>source", "customer_account");
    expect(eq).toHaveBeenCalledWith("metadata->>idempotencyKey", "idem-1");
  });

  it("reads owned pets by pet id and client id", async () => {
    const row = { id: "pet-1" };
    const maybeSingle = vi.fn(async () => ({ data: row, error: null }));
    const eq = vi.fn(() => ({ eq, maybeSingle }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));

    await expect(readOwnedPet({ from } as never, "client-1", "pet-1")).resolves.toBe(row);

    expect(from).toHaveBeenCalledWith("pets");
    expect(eq).toHaveBeenCalledWith("id", "pet-1");
    expect(eq).toHaveBeenCalledWith("client_id", "client-1");
  });

  it("returns replay data and records an operational event without mutating", async () => {
    const limit = vi.fn(async () => ({ data: [{ id: "event-1" }], error: null }));
    const eq = vi.fn(() => ({ eq, limit }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const mutate = vi.fn(async () => "mutated");
    const readReplay = vi.fn(async () => "replayed");
    const operationalEvents = vi.fn();

    await expect(
      runIdempotentCustomerMutation({
        client: { from } as never,
        clientId: "client-1",
        eventType: "customer.profile_updated",
        idempotencyKey: "idem-1",
        readReplay,
        mutate,
        operationalEvents,
      }),
    ).resolves.toBe("replayed");

    expect(readReplay).toHaveBeenCalledTimes(1);
    expect(mutate).not.toHaveBeenCalled();
    expect(operationalEvents).toHaveBeenCalledWith({
      name: "customer_self_service_idempotency_replay",
      domain: "customers",
      surface: "customer",
      details: { eventType: "customer.profile_updated" },
    });
  });

  it("falls through to mutation without replay telemetry when replay data is missing", async () => {
    const limit = vi.fn(async () => ({ data: [{ id: "event-1" }], error: null }));
    const eq = vi.fn(() => ({ eq, limit }));
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    const mutate = vi.fn(async () => "mutated");
    const readReplay = vi.fn(async () => null);
    const operationalEvents = vi.fn();

    await expect(
      runIdempotentCustomerMutation({
        client: { from } as never,
        clientId: "client-1",
        eventType: "customer.pet_updated",
        idempotencyKey: "idem-1",
        readReplay,
        mutate,
        operationalEvents,
      }),
    ).resolves.toBe("mutated");

    expect(readReplay).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledTimes(1);
    expect(operationalEvents).not.toHaveBeenCalled();
  });
});
