import { describe, expect, it } from "vitest";
import {
  createClientsRecipientPort,
  type ClientsRecipientSupabaseClient,
} from "./clientsRecipient.js";

type Result = { data: unknown; error: { code?: string; message?: string } | null };

function clientReturning(result: Result): {
  client: ClientsRecipientSupabaseClient;
  calls: { table?: string; columns?: string; idColumn?: string; idValue?: unknown };
} {
  const calls: { table?: string; columns?: string; idColumn?: string; idValue?: unknown } = {};
  const builder = {
    select(columns: string) {
      calls.columns = columns;
      return builder;
    },
    eq(column: string, value: unknown) {
      calls.idColumn = column;
      calls.idValue = value;
      return builder;
    },
    maybeSingle() {
      return Promise.resolve(result);
    },
  };
  const client: ClientsRecipientSupabaseClient = {
    from(table: string) {
      calls.table = table;
      return builder;
    },
  };
  return { client, calls };
}

const signal = new AbortController().signal;

describe("createClientsRecipientPort", () => {
  it("reads clients(email, first_name, country) by id and maps a full row", async () => {
    const { client, calls } = clientReturning({
      data: { email: "a@b.pl", first_name: "Ada", country: "PL" },
      error: null,
    });
    const port = createClientsRecipientPort(client, { errorPrefix: "x_read_failed" });

    const recipient = await port.resolve("client-1", signal);

    expect(recipient).toEqual({ email: "a@b.pl", firstName: "Ada", country: "PL" });
    expect(calls).toEqual({
      table: "clients",
      columns: "email, first_name, country",
      idColumn: "id",
      idValue: "client-1",
    });
  });

  it("normalizes empty/missing first_name and country to null", async () => {
    const { client } = clientReturning({
      data: { email: "a@b.pl", first_name: "", country: null },
      error: null,
    });
    const port = createClientsRecipientPort(client, { errorPrefix: "x_read_failed" });

    expect(await port.resolve("client-1", signal)).toEqual({
      email: "a@b.pl",
      firstName: null,
      country: null,
    });
  });

  it("returns null when the row is missing or has no email", async () => {
    const missing = createClientsRecipientPort(clientReturning({ data: null, error: null }).client, {
      errorPrefix: "x_read_failed",
    });
    expect(await missing.resolve("client-1", signal)).toBeNull();

    const emptyEmail = createClientsRecipientPort(
      clientReturning({ data: { email: "" }, error: null }).client,
      { errorPrefix: "x_read_failed" },
    );
    expect(await emptyEmail.resolve("client-1", signal)).toBeNull();
  });

  it("throws with the supplied error prefix, preferring message then code", async () => {
    const withMessage = createClientsRecipientPort(
      clientReturning({ data: null, error: { code: "PGRST", message: "boom" } }).client,
      { errorPrefix: "subscription_recipient_read_failed" },
    );
    await expect(withMessage.resolve("client-1", signal)).rejects.toThrow(
      "subscription_recipient_read_failed: boom",
    );

    const codeOnly = createClientsRecipientPort(
      clientReturning({ data: null, error: { code: "PGRST" } }).client,
      { errorPrefix: "dunning_recipient_read_failed" },
    );
    await expect(codeOnly.resolve("client-1", signal)).rejects.toThrow(
      "dunning_recipient_read_failed: PGRST",
    );
  });
});
