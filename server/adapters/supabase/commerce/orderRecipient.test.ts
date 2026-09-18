import { describe, expect, it, vi } from "vitest";
import { createSupabaseOrderRecipientPort } from "./orderRecipient.js";

type QueryResult = { data: unknown; error: { code?: string; message?: string } | null };

function chain(result: QueryResult) {
  const builder = {
    select: vi.fn(() => builder),
    eq: vi.fn(() => builder),
    maybeSingle: vi.fn(async () => result),
  };
  return builder;
}

function clientFor(
  orderResult: QueryResult,
  clientResult: QueryResult,
  petResult: QueryResult = { data: null, error: null },
) {
  const orderChain = chain(orderResult);
  const clientChain = chain(clientResult);
  const petChain = chain(petResult);
  const from = vi.fn((table: string) => {
    if (table === "commerce_orders") return orderChain;
    if (table === "clients") return clientChain;
    if (table === "pets") return petChain;
    throw new Error(`unexpected table ${table}`);
  });
  return { client: { from }, from, orderChain, clientChain, petChain };
}

const signal = new AbortController().signal;

describe("supabase order recipient port", () => {
  it("resolves email and firstName via commerce_orders.client_id -> clients", async () => {
    const { client, orderChain, clientChain } = clientFor(
      { data: { client_id: "client-1" }, error: null },
      { data: { email: "anna@example.com", first_name: "Anna", country: "GB" }, error: null },
    );
    const port = createSupabaseOrderRecipientPort(client);

    await expect(port.resolve("order-uuid-1", signal)).resolves.toEqual({
      email: "anna@example.com",
      firstName: "Anna",
      country: "GB",
      petName: null,
    });
    expect(orderChain.select).toHaveBeenCalledWith("client_id, pet_id, metadata");
    expect(orderChain.eq).toHaveBeenCalledWith("id", "order-uuid-1");
    expect(clientChain.select).toHaveBeenCalledWith("email, first_name, country");
    expect(clientChain.eq).toHaveBeenCalledWith("id", "client-1");
  });

  it("maps a missing first_name and empty country to nulls", async () => {
    const { client } = clientFor(
      { data: { client_id: "client-1" }, error: null },
      { data: { email: "anna@example.com", first_name: null, country: "" }, error: null },
    );
    await expect(createSupabaseOrderRecipientPort(client).resolve("order-uuid-1", signal))
      .resolves.toEqual({ email: "anna@example.com", firstName: null, country: null, petName: null });
  });

  it("uses the durable order metadata pet snapshot before reading pets", async () => {
    const { client, from } = clientFor(
      {
        data: {
          client_id: "client-1",
          pet_id: "pet-1",
          metadata: { runtimeFinalize: { petName: " Fistaszek " } },
        },
        error: null,
      },
      { data: { email: "anna@example.com", first_name: "Anna", country: "PL" }, error: null },
    );

    await expect(createSupabaseOrderRecipientPort(client).resolve("order-uuid-1", signal))
      .resolves.toMatchObject({ petName: "Fistaszek" });
    expect(from).not.toHaveBeenCalledWith("pets");
  });

  it("uses the documented metadata precedence", async () => {
    const { client } = clientFor(
      {
        data: {
          client_id: "client-1",
          pet_id: "pet-1",
          metadata: {
            petName: "Top-level",
            runtimeFinalize: { petName: "Runtime" },
            petSnapshot: { name: "Snapshot" },
          },
        },
        error: null,
      },
      { data: { email: "anna@example.com", first_name: "Anna", country: "PL" }, error: null },
    );

    await expect(createSupabaseOrderRecipientPort(client).resolve("order-uuid-1", signal))
      .resolves.toMatchObject({ petName: "Top-level" });
  });

  it("falls back to the legacy pet snapshot name", async () => {
    const { client } = clientFor(
      {
        data: {
          client_id: "client-1",
          metadata: { petSnapshot: { name: "Snapshot" } },
        },
        error: null,
      },
      { data: { email: "anna@example.com", first_name: "Anna", country: "PL" }, error: null },
    );

    await expect(createSupabaseOrderRecipientPort(client).resolve("order-uuid-1", signal))
      .resolves.toMatchObject({ petName: "Snapshot" });
  });

  it("resolves the exact order pet and validates client ownership", async () => {
    const { client, petChain } = clientFor(
      { data: { client_id: "client-1", pet_id: "pet-2", metadata: {} }, error: null },
      { data: { email: "anna@example.com", first_name: "Anna", country: "PL" }, error: null },
      { data: { name: "Luna" }, error: null },
    );

    await expect(createSupabaseOrderRecipientPort(client).resolve("order-uuid-1", signal))
      .resolves.toMatchObject({ petName: "Luna" });
    expect(petChain.eq).toHaveBeenNthCalledWith(1, "id", "pet-2");
    expect(petChain.eq).toHaveBeenNthCalledWith(2, "client_id", "client-1");
  });

  it("keeps delivery generic when the pet lookup fails", async () => {
    const { client } = clientFor(
      { data: { client_id: "client-1", pet_id: "pet-1", metadata: {} }, error: null },
      { data: { email: "anna@example.com", first_name: "Anna", country: "PL" }, error: null },
      { data: null, error: { message: "pet read down" } },
    );

    await expect(createSupabaseOrderRecipientPort(client).resolve("order-uuid-1", signal))
      .resolves.toMatchObject({ petName: null });
  });

  it("keeps delivery generic when the pet query throws", async () => {
    const { client, petChain } = clientFor(
      { data: { client_id: "client-1", pet_id: "pet-1", metadata: {} }, error: null },
      { data: { email: "anna@example.com", first_name: "Anna", country: "PL" }, error: null },
    );
    petChain.maybeSingle.mockRejectedValueOnce(new Error("connection dropped"));

    await expect(createSupabaseOrderRecipientPort(client).resolve("order-uuid-1", signal))
      .resolves.toMatchObject({ petName: null });
  });

  it("returns null without querying clients when the order has no client_id", async () => {
    const { client, from } = clientFor(
      { data: { client_id: null }, error: null },
      { data: { email: "never@example.com", first_name: null }, error: null },
    );
    await expect(createSupabaseOrderRecipientPort(client).resolve("order-uuid-1", signal))
      .resolves.toBeNull();
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("commerce_orders");
  });

  it("returns null when the order row does not exist", async () => {
    const { client, from } = clientFor(
      { data: null, error: null },
      { data: null, error: null },
    );
    await expect(createSupabaseOrderRecipientPort(client).resolve("missing-order", signal))
      .resolves.toBeNull();
    expect(from).toHaveBeenCalledTimes(1);
  });

  it("returns null when the client row is missing or has no email", async () => {
    const missingClient = clientFor(
      { data: { client_id: "client-1" }, error: null },
      { data: null, error: null },
    );
    await expect(createSupabaseOrderRecipientPort(missingClient.client).resolve("o", signal))
      .resolves.toBeNull();

    const emptyEmail = clientFor(
      { data: { client_id: "client-1" }, error: null },
      { data: { email: "", first_name: "Anna" }, error: null },
    );
    await expect(createSupabaseOrderRecipientPort(emptyEmail.client).resolve("o", signal))
      .resolves.toBeNull();
  });

  it("throws when either query errors", async () => {
    const orderError = clientFor(
      { data: null, error: { code: "08000", message: "order read down" } },
      { data: null, error: null },
    );
    await expect(createSupabaseOrderRecipientPort(orderError.client).resolve("o", signal))
      .rejects.toThrow(/outbox_recipient_order_read_failed.*order read down/);

    const clientError = clientFor(
      { data: { client_id: "client-1" }, error: null },
      { data: null, error: { code: "08000", message: "client read down" } },
    );
    await expect(createSupabaseOrderRecipientPort(clientError.client).resolve("o", signal))
      .rejects.toThrow(/outbox_recipient_client_read_failed.*client read down/);
  });
});
