import { describe, expect, it } from "vitest";
import { createSupabaseAdminPrelaunchLeadsPort, type AdminPrelaunchSupabaseClient } from "./adminPrelaunchLeadsPort.js";

describe("supabase admin prelaunch leads port", () => {
  it("keeps linked waitlist source refs when filtering for tester leads", async () => {
    const port = createSupabaseAdminPrelaunchLeadsPort(fakeClient({
      testers: [{
        id: "tester-1",
        email: "jan@example.com",
        first_name: "Jan",
        last_name: "Kowalski",
        phone: "123456789",
        status: "delivered",
        created_at: "2026-07-05T10:00:00.000Z",
        delivered_at: "2026-07-06T10:00:00.000Z",
        dog_name: "Figa",
        dog_breed: "mix",
        dog_age: "3",
        dog_weight_kg: 12,
        cat_name: null,
        cat_breed: null,
        cat_age: null,
        cat_weight_kg: null,
        pet_type: "dog",
        verification_consent: true,
        newsletter_consent: false,
        email_sequence_paused: false,
      }],
      waitlist: [{
        id: "waitlist-1",
        email: "jan@example.com",
        first_name: "Jan",
        last_name: "Kowalski",
        created_at: "2026-07-04T10:00:00.000Z",
        dog_name: "Figa",
        dog_breed: "mix",
        dog_age: "3",
        dog_weight_kg: 12,
        marketing_launch_offer_consent: true,
        source: "launch-popup",
        locale: "pl",
      }],
      feedback: [],
      clients: [],
    }));

    const result = await port.listPrelaunchLeads({
      page: 0,
      pageSize: 50,
      source: "tester",
      stage: "all",
    });

    expect(result.leads).toHaveLength(1);
    expect(result.leads[0].sourceRefs).toEqual(["testers:tester-1", "waitlist:waitlist-1"]);
    expect(result.leads[0].attributionSummary).toEqual({
      waitlistSource: "launch-popup",
      waitlistLocale: "pl",
    });
  });

  it("falls back to nullable waitlist attribution when the DB migration has not landed yet", async () => {
    const port = createSupabaseAdminPrelaunchLeadsPort(fakeClient({
      testers: [],
      waitlist: [{
        id: "waitlist-1",
        email: "ada@example.com",
        first_name: "Ada",
        last_name: null,
        created_at: "2026-07-04T10:00:00.000Z",
        dog_name: "Figa",
        dog_breed: "mix",
        dog_age: "3",
        dog_weight_kg: 12,
        marketing_launch_offer_consent: true,
      }],
      feedback: [],
      clients: [],
    }, { missingWaitlistAttributionColumns: true }));

    const result = await port.listPrelaunchLeads({
      page: 0,
      pageSize: 50,
      source: "waitlist",
      stage: "all",
    });

    expect(result.leads[0].attributionSummary).toEqual({
      waitlistSource: null,
      waitlistLocale: null,
    });
  });
});

function fakeClient(
  rows: Record<string, unknown[]>,
  options: { missingWaitlistAttributionColumns?: boolean } = {},
): AdminPrelaunchSupabaseClient {
  return {
    from(table) {
      return new FakeQuery(rows[table] ?? [], {
        missingAttributionColumns: table === "waitlist" && options.missingWaitlistAttributionColumns === true,
      });
    },
  };
}

class FakeQuery implements PromiseLike<{ data: unknown[] | null; error: { message?: string } | null }> {
  private column: string | null = null;
  private value: string | null = null;
  private columns = "";

  constructor(
    private readonly rows: unknown[],
    private readonly options: { missingAttributionColumns: boolean },
  ) {}

  select(columns: string): FakeQuery {
    this.columns = columns;
    return this;
  }

  order(): FakeQuery {
    return this;
  }

  limit(): FakeQuery {
    return this;
  }

  in(): FakeQuery {
    return this;
  }

  eq(column: string, value: string): FakeQuery {
    this.column = column;
    this.value = value;
    return this;
  }

  then<TResult1 = { data: unknown[] | null; error: { message?: string } | null }, TResult2 = never>(
    onfulfilled?: ((value: { data: unknown[] | null; error: { message?: string } | null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    if (this.options.missingAttributionColumns && /\b(source|locale)\b/.test(this.columns)) {
      return Promise.resolve({
        data: null,
        error: { message: "column waitlist.source does not exist" },
      }).then(onfulfilled, onrejected);
    }

    const data = this.column
      ? this.rows.filter((row) => (row as Record<string, unknown>)[this.column as string] === this.value)
      : this.rows;
    return Promise.resolve({ data, error: null }).then(onfulfilled, onrejected);
  }
}
