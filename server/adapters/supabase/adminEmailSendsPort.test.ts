import { describe, expect, it } from "vitest";
import { createAdminEmailSendsReadPort } from "./adminEmailSendsPort.js";

describe("admin email sends Supabase read port", () => {
  it("executes the complete unfiltered admin read and preserves provider order, nulls, stats, and event order", async () => {
    const client = new FakeClient({
      email_sends: [
        {
          id: "send-2",
          tester_id: "tester-2",
          template_slug: "second",
          status: "delivered",
          source: "manual",
          provider_response: null,
          created_at: "2026-07-02T10:00:00+00:00",
        },
        {
          id: "send-1",
          tester_id: "tester-1",
          template_slug: "first",
          status: "sent",
          source: "manual",
          provider_response: null,
          created_at: "2026-07-01T10:00:00+00:00",
        },
      ],
      email_events: [
        { send_id: "send-2", event_type: "open", timestamp: "2026-07-02T10:01:00+00:00" },
        { send_id: "send-2", event_type: "click", timestamp: "2026-07-02T10:02:00+00:00" },
        { send_id: "send-2", event_type: "open", timestamp: "2026-07-02T10:03:00+00:00" },
      ],
      testers: [
        { id: "tester-1", first_name: "First", last_name: null, email: "first@example.test" },
        { id: "tester-2", first_name: null, last_name: "Second", email: "second@example.test" },
      ],
      communication_email_deliveries: [],
    });

    await expect(createAdminEmailSendsReadPort(client as never).getAdminEmailSends({
      status: "all",
      template: "all",
      search: "   ",
      page: 0,
      pageSize: 20,
    })).resolves.toEqual({
      stats: { totalSent: 2, delivered: 1, opened: 2, clicked: 1 },
      templateSlugs: ["first", "second"],
      sends: [
        expect.objectContaining({
          id: "send-2",
          testers: { id: "tester-2", first_name: null, last_name: "Second", email: "second@example.test" },
          delivery_aggregate_id: null,
          delivery_status: null,
          recipient_label: null,
        }),
        expect.objectContaining({
          id: "send-1",
          testers: { id: "tester-1", first_name: "First", last_name: null, email: "first@example.test" },
          delivery_aggregate_id: null,
          delivery_status: null,
          recipient_label: null,
        }),
      ],
      totalCount: 2,
      eventsSummary: { "send-2": ["open", "click"] },
    });

    expect(client.calls).toEqual([
      call("rpc:communication_admin_email_sends_stats", [["rpc", {}]]),
      call("rpc:communication_admin_email_template_slugs", [["rpc", {}]]),
      call("email_sends", [
        ["select", "*, testers!email_sends_tester_id_fkey(first_name, last_name, email)"],
        ["order", "created_at", { ascending: false }],
        ["range", 0, 19],
      ]),
      call("email_sends", [["select", "*", { count: "exact", head: true }]]),
      call("communication_email_deliveries", [
        ["select", "email_send_id, status, last_error_code, outbox_event_id, aggregate_type, aggregate_id, provider_message_id"],
        ["in", "email_send_id", ["send-2", "send-1"]],
      ]),
      call("email_events", [["select", "send_id, event_type"], ["in", "send_id", ["send-2", "send-1"]]]),
    ]);
    expect(client.calls).toHaveLength(6);
  });

  it("keeps global stats independent of status, template, and page filters", async () => {
    const client = new FakeClient({
      email_sends: [
        { id: "send-3", template_slug: "alpha", status: "delivered", created_at: "2026-07-03" },
        { id: "send-2", template_slug: "beta", status: "delivered", created_at: "2026-07-02" },
        { id: "send-1", template_slug: "beta", status: "sent", created_at: "2026-07-01" },
        { id: "send-0", template_slug: null, status: "failed", created_at: "2026-06-30" },
      ],
      email_events: [
        { send_id: "send-2", event_type: "open" },
        { send_id: "send-2", event_type: "open" },
        { send_id: "send-1", event_type: "click" },
      ],
      testers: [],
    });

    await expect(createAdminEmailSendsReadPort(client as never).getAdminEmailSends({
      status: "delivered",
      template: "beta",
      search: "",
      page: 1,
      pageSize: 1,
    })).resolves.toEqual({
      stats: { totalSent: 4, delivered: 2, opened: 2, clicked: 1 },
      templateSlugs: ["alpha", "beta"],
      sends: [],
      totalCount: 1,
      eventsSummary: {},
    });

    expect(client.calls).toEqual([
      call("rpc:communication_admin_email_sends_stats", [["rpc", {}]]),
      call("rpc:communication_admin_email_template_slugs", [["rpc", {}]]),
      call("email_sends", [
        ["select", "*, testers!email_sends_tester_id_fkey(first_name, last_name, email)"],
        ["order", "created_at", { ascending: false }],
        ["range", 1, 1],
        ["eq", "status", "delivered"],
        ["eq", "template_slug", "beta"],
      ]),
      call("email_sends", [
        ["select", "*", { count: "exact", head: true }],
        ["eq", "status", "delivered"],
        ["eq", "template_slug", "beta"],
      ]),
    ]);
  });

  it("forwards statistics RPC failures and rejects malformed statistics", async () => {
    const failure = { message: "stats denied" };
    const failedClient = new FakeClient({ email_sends: [], email_events: [] }, {
      data: null,
      error: failure,
    });
    const malformedClient = new FakeClient({ email_sends: [], email_events: [] }, {
      data: { totalSent: 0, delivered: 0, opened: 0 },
      error: null,
    });
    const request = { status: "all", template: "all", search: "", page: 0, pageSize: 20 };

    await expect(
      createAdminEmailSendsReadPort(failedClient as never).getAdminEmailSends(request),
    ).rejects.toBe(failure);
    await expect(
      createAdminEmailSendsReadPort(malformedClient as never).getAdminEmailSends(request),
    ).rejects.toThrow("admin_email_sends_stats_invalid_response");
  });

  it("accepts an empty slug array and sorts complete results by JS UTF-16 code units", async () => {
    const request = { status: "all", template: "all", search: "", page: 0, pageSize: 20 };
    const client = new FakeClient(
      { email_sends: [], email_events: [] },
      undefined,
      { data: ["Żaba", "zeta", "😀", "\uE000", "alpha", "Zaba", " "], error: null },
    );

    const result = await createAdminEmailSendsReadPort(client as never).getAdminEmailSends(request);

    expect(result.templateSlugs).toEqual([" ", "Zaba", "alpha", "zeta", "Żaba", "😀", "\uE000"]);
    expect(client.calls[1]).toEqual(
      call("rpc:communication_admin_email_template_slugs", [["rpc", {}]]),
    );

    const emptyClient = new FakeClient({ email_sends: [], email_events: [] });
    await expect(
      createAdminEmailSendsReadPort(emptyClient as never).getAdminEmailSends(request),
    ).resolves.toMatchObject({ templateSlugs: [] });
  });

  it("forwards template-slug RPC failures and rejects malformed slug arrays", async () => {
    const failure = { message: "slug read denied" };
    const request = { status: "all", template: "all", search: "", page: 0, pageSize: 20 };
    const failedClient = new FakeClient(
      { email_sends: [], email_events: [] },
      undefined,
      { data: null, error: failure },
    );

    await expect(
      createAdminEmailSendsReadPort(failedClient as never).getAdminEmailSends(request),
    ).rejects.toBe(failure);

    for (const malformed of [null, ["valid", ""], ["valid", 1], ["duplicate", "duplicate"]]) {
      const malformedClient = new FakeClient(
        { email_sends: [], email_events: [] },
        undefined,
        { data: malformed, error: null },
      );
      await expect(
        createAdminEmailSendsReadPort(malformedClient as never).getAdminEmailSends(request),
      ).rejects.toThrow("admin_email_template_slugs_invalid_response");
    }
  });

  it("finds live outbox sends without tester_id by order ref and exposes delivery evidence", async () => {
    const orderId = "999df1b0-cb11-47e2-ad80-e874bd900a38";
    const client = new FakeClient({
      email_sends: [
        {
          id: "send-live-1",
          tester_id: null,
          template_id: null,
          template_slug: "commerce-order-paid",
          source: "outbox-dispatch",
          resend_id: null,
          status: "failed",
          sent_at: null,
          provider_error: "Resend HTTP 500",
          provider_response: {
            outboxEventId: "outbox-1",
            orderId,
          },
          created_at: "2026-06-28T10:00:00+00:00",
        },
      ],
      email_events: [],
      testers: [],
      commerce_orders: [{ id: orderId, order_number: "OPENLUP-999DF1B0" }],
      communication_email_deliveries: [
        {
          email_send_id: "send-live-1",
          status: "failed",
          last_error_code: "resend_http_500",
          outbox_event_id: "outbox-1",
          aggregate_type: "commerce_order",
          aggregate_id: orderId,
          provider_message_id: null,
        },
      ],
    });

    const result = await createAdminEmailSendsReadPort(client as never).getAdminEmailSends({
      status: "all",
      template: "all",
      search: "OPENLUP-999DF1B0",
      page: 0,
      pageSize: 20,
    });

    expect(result.totalCount).toBe(1);
    expect(result.sends[0]).toMatchObject({
      id: "send-live-1",
      tester_id: null,
      recipient_label: "Zamówienie OPENLUP-999DF1B0",
      delivery_status: "failed",
      delivery_last_error_code: "resend_http_500",
      delivery_outbox_event_id: "outbox-1",
      delivery_aggregate_id: orderId,
      delivery_order_number: "OPENLUP-999DF1B0",
    });
  });

  it("reads one send's events with the canonical chronological query and forwards query failures", async () => {
    const client = new FakeClient({
      email_events: [
        { id: "event-1", send_id: "send-1", event_type: "open", timestamp: null },
        { id: "event-2", send_id: "send-1", event_type: "click", timestamp: "2026-07-02" },
      ],
    });
    await expect(
      createAdminEmailSendsReadPort(client as never).getAdminEmailSendEvents({ sendId: "send-1" }),
    ).resolves.toEqual({
      events: [
        { id: "event-1", send_id: "send-1", event_type: "open", timestamp: null },
        { id: "event-2", send_id: "send-1", event_type: "click", timestamp: "2026-07-02" },
      ],
    });
    expect(client.calls).toEqual([call("email_events", [
      ["select", "*"],
      ["eq", "send_id", "send-1"],
      ["order", "timestamp", { ascending: true }],
    ])]);

    const failure = { message: "events denied" };
    const failedClient = {
      from: () => {
        const query = {
          select: () => query,
          eq: () => query,
          order: () => query,
          then: (resolve: (value: { data: null; error: typeof failure }) => unknown) =>
            Promise.resolve({ data: null, error: failure }).then(resolve),
        };
        return query;
      },
    };
    await expect(
      createAdminEmailSendsReadPort(failedClient as never).getAdminEmailSendEvents({ sendId: "send-1" }),
    ).rejects.toBe(failure);
  });
});

type Row = Record<string, unknown>;

class FakeClient {
  readonly calls: QueryCall[] = [];

  constructor(
    private readonly rows: Record<string, Row[]>,
    private readonly statsResult?: { data: unknown; error: unknown | null },
    private readonly templateSlugsResult?: { data: unknown; error: unknown | null },
  ) {}

  async rpc(functionName: string, args: Record<string, never>) {
    this.calls.push(call(`rpc:${functionName}`, [["rpc", args]]));
    const sends = this.rows.email_sends ?? [];
    if (functionName === "communication_admin_email_template_slugs") {
      if (this.templateSlugsResult) return this.templateSlugsResult;
      return {
        data: [...new Set(sends
          .map((row) => row.template_slug)
          .filter((slug): slug is string => typeof slug === "string" && slug.length > 0))],
        error: null,
      };
    }
    if (functionName !== "communication_admin_email_sends_stats") {
      throw new Error(`unexpected RPC: ${functionName}`);
    }
    if (this.statsResult) return this.statsResult;
    const events = this.rows.email_events ?? [];
    return {
      data: {
        totalSent: sends.length,
        delivered: sends.filter((row) => row.status === "delivered").length,
        opened: events.filter((row) => row.event_type === "open").length,
        clicked: events.filter((row) => row.event_type === "click").length,
      },
      error: null,
    };
  }

  from(table: string) {
    const queryCall = call(table, []);
    this.calls.push(queryCall);
    return new QueryBuilder(table, this.rows, queryCall);
  }
}

type QueryCall = { table: string; operations: unknown[][] };

function call(table: string, operations: unknown[][]): QueryCall {
  return { table, operations };
}

class QueryBuilder implements PromiseLike<{ data: Row[] | null; count?: number | null; error: null }> {
  private filters: Array<(row: Row) => boolean> = [];
  private selected = "*";
  private head = false;
  private limitCount: number | null = null;
  private rangeFrom = 0;
  private rangeTo: number | null = null;
  private descendingOrderColumn: string | null = null;

  constructor(
    private readonly table: string,
    private readonly rows: Record<string, Row[]>,
    private readonly call: QueryCall,
  ) {}

  select(columns: string, options?: { count?: string; head?: boolean }) {
    this.call.operations.push(options ? ["select", columns, options] : ["select", columns]);
    this.selected = columns;
    this.head = options?.head === true;
    return this;
  }

  eq(column: string, value: unknown) {
    this.call.operations.push(["eq", column, value]);
    this.filters.push((row) => readPath(row, column) === value);
    return this;
  }

  in(column: string, values: unknown[]) {
    this.call.operations.push(["in", column, values]);
    this.filters.push((row) => values.includes(readPath(row, column)));
    return this;
  }

  not(column: string, operator: string, value: unknown) {
    this.call.operations.push(["not", column, operator, value]);
    if (operator === "is" && value === null) {
      this.filters.push((row) => readPath(row, column) !== null && readPath(row, column) !== undefined);
    }
    return this;
  }

  or(pattern: string) {
    this.call.operations.push(["or", pattern]);
    const clauses = pattern.split(",");
    this.filters.push((row) => clauses.some((clause) => matchClause(row, clause)));
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.call.operations.push(options ? ["order", column, options] : ["order", column]);
    if (options?.ascending === false) this.descendingOrderColumn = column;
    return this;
  }

  range(from: number, to: number) {
    this.call.operations.push(["range", from, to]);
    this.rangeFrom = from;
    this.rangeTo = to;
    return this;
  }

  limit(count: number) {
    this.call.operations.push(["limit", count]);
    this.limitCount = count;
    return this;
  }

  then<TResult1 = { data: Row[] | null; count?: number | null; error: null }, TResult2 = never>(
    onfulfilled?: ((value: { data: Row[] | null; count?: number | null; error: null }) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.execute()).then(onfulfilled, onrejected);
  }

  private execute() {
    let data = [...(this.rows[this.table] ?? [])].filter((row) => this.filters.every((filter) => filter(row)));
    if (this.table === "email_sends" && /testers(?:![^(]+)?\(/u.test(this.selected)) {
      data = data.map((row) => ({
        ...row,
        testers: (this.rows.testers ?? []).find((tester) => tester.id === row.tester_id) ?? null,
      }));
    }
    if (this.descendingOrderColumn) {
      data.sort((a, b) => String(b[this.descendingOrderColumn!] ?? "").localeCompare(String(a[this.descendingOrderColumn!] ?? "")));
    }
    const count = data.length;
    if (this.rangeTo !== null) data = data.slice(this.rangeFrom, this.rangeTo + 1);
    if (this.limitCount !== null) data = data.slice(0, this.limitCount);
    return { data: this.head ? null : data, count, error: null };
  }
}

function readPath(row: Row, column: string): unknown {
  const jsonMatch = column.match(/^provider_response->>(.+)$/);
  if (jsonMatch) {
    const response = row.provider_response;
    return response && typeof response === "object" ? (response as Row)[jsonMatch[1]] : undefined;
  }
  return row[column];
}

function matchClause(row: Row, clause: string): boolean {
  const match = clause.match(/^(.+)\.ilike\.%(.*)%$/);
  if (!match) return false;
  const value = readPath(row, match[1]);
  return typeof value === "string" && value.toLowerCase().includes(match[2].toLowerCase());
}
