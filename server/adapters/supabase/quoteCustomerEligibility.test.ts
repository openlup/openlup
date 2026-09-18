import { describe, expect, it } from "vitest";
import type { CreateQuoteRequest } from "../../../src/domains/commerce/contracts.js";
import {
  resolveQuoteCustomerEligibility,
  type QuoteCustomerEligibilityClient,
} from "./quoteCustomerEligibility.js";

type ClientRow = { id: string; email: string; created_at: string };

describe("resolveQuoteCustomerEligibility", () => {
  it("stays anonymous when no eligibility email is provided", async () => {
    const client = fakeClient([]);

    await expect(resolveQuoteCustomerEligibility(client, request())).resolves.toEqual({
      clientId: null,
      source: "anonymous",
      matchKind: null,
    });
  });

  it("prefers the exact lowercase email match and tags it as an exact match", async () => {
    const client = fakeClient([
      { id: "plus", email: "anna+old@example.com", created_at: "2026-01-01T00:00:00Z" },
      { id: "exact", email: "anna+promo@example.com", created_at: "2026-02-01T00:00:00Z" },
    ]);

    await expect(
      resolveQuoteCustomerEligibility(
        client,
        request({ customerEligibilityContext: { email: "anna+promo@example.com" } }),
      ),
    ).resolves.toEqual({ clientId: "exact", source: "resolved_client", matchKind: "exact" });
  });

  it("falls back to plus-normalized email (tagged plus_normalized) so first-order promos use checkout identity", async () => {
    const client = fakeClient([
      { id: "base", email: "anna@example.com", created_at: "2026-01-01T00:00:00Z" },
    ]);

    // A `+tag` alias resolves the base client for eligibility/anti-farming, but is
    // tagged `plus_normalized` — NOT `exact` — so recognition never fires on it.
    await expect(
      resolveQuoteCustomerEligibility(
        client,
        request({ customerEligibilityContext: { email: "anna+promo@example.com" } }),
      ),
    ).resolves.toEqual({ clientId: "base", source: "resolved_client", matchKind: "plus_normalized" });
  });

  it("stays anonymous when a distinct email has no exact or plus-normalized match", async () => {
    const client = fakeClient([
      { id: "base", email: "anna@example.com", created_at: "2026-01-01T00:00:00Z" },
    ]);

    await expect(
      resolveQuoteCustomerEligibility(
        client,
        request({ customerEligibilityContext: { email: "stranger@example.com" } }),
      ),
    ).resolves.toEqual({ clientId: null, source: "anonymous", matchKind: null });
  });
});

function request(overrides: Partial<CreateQuoteRequest> = {}): CreateQuoteRequest {
  return {
    mode: "subscription",
    cadenceDays: 21,
    promoCodes: [],
    lines: [{ sku: "opaque:lamb-launch.v1", quantity: 14, modeAtLine: "subscription" }],
    ...overrides,
  } as CreateQuoteRequest;
}

function fakeClient(rows: ClientRow[]): QuoteCustomerEligibilityClient {
  return {
    from: () => new Query(rows),
  };
}

class Query {
  private rows: ClientRow[];
  private single = false;

  constructor(rows: ClientRow[]) {
    this.rows = rows;
  }

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.rows = this.rows.filter((row) => row[column as keyof typeof row] === value);
    return this;
  }

  ilike(column: string, pattern: string): this {
    const regex = new RegExp(`^${pattern.replace(/%/g, ".*")}$`, "i");
    this.rows = this.rows.filter((row) => regex.test(String(row[column as keyof typeof row])));
    return this;
  }

  order(): this {
    this.rows = [...this.rows].sort((a, b) => a.created_at.localeCompare(b.created_at));
    return this;
  }

  limit(count: number): this {
    this.rows = this.rows.slice(0, count);
    return this;
  }

  maybeSingle(): Promise<{ data: ClientRow | null; error: null }> {
    return Promise.resolve({ data: this.rows[0] ?? null, error: null });
  }

  then<TResult1, TResult2>(
    onfulfilled?: ((value: { data: ClientRow[]; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    _onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve({ data: this.rows, error: null }).then(onfulfilled as never);
  }
}
