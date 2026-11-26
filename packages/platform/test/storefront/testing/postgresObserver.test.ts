import { describe, expect, it } from "vitest";
import { createPostgresStorefrontObserver } from "../../../src/storefront/testing/index.js";

type Call = { text: string; values: readonly unknown[] | undefined };
type Answer = readonly Record<string, unknown>[] | Error;

const isRead = (text: string) => /^\s*(?:SELECT|WITH)\b/i.test(text);

/**
 * An executor over one recorded session: each read statement takes the next
 * scripted answer (rows, or an error it rejects with); transaction and setting
 * statements answer no rows unless `failControl` names them.
 */
function recordingExecutor(answers: readonly Answer[], failControl: Readonly<Record<string, Error>> = {}) {
  const calls: Call[] = [];
  let next = 0;
  return {
    calls,
    texts: () => calls.map((call) => (isRead(call.text) ? "<read>" : call.text)),
    async query(text: string, values?: readonly unknown[]) {
      calls.push({ text, values });
      if (!isRead(text)) {
        const failure = failControl[text];
        if (failure !== undefined) throw failure;
        return { rows: [] };
      }
      const answer = answers[next++];
      if (answer === undefined) throw new Error("recording executor: no scripted answer left");
      if (answer instanceof Error) throw answer;
      return { rows: answer.map((row) => ({ ...row })) };
    },
  };
}

const session = { row_security: "off", transaction_read_only: "on" };
const ledgerRow = (counts: Partial<Record<"orders" | "payable_orders" | "holds" | "attempts" | "captures", unknown>> = {}) =>
  ({ ...session, orders: "0", payable_orders: "0", holds: "0", attempts: "0", captures: "0", ...counts });
const committed = ["BEGIN READ ONLY", "SET LOCAL row_security = off", "<read>", "COMMIT"];
const rolledBack = ["BEGIN READ ONLY", "SET LOCAL row_security = off", "<read>", "ROLLBACK"];

/** Read-only statement shape: one SELECT or WITH, no write, row lock or transaction control. */
function expectReadOnly(text: string) {
  expect(text.trimStart()).toMatch(/^(?:SELECT|WITH)\b/i);
  for (const refused of [/\bINSERT\b/i, /\bUPDATE\b/i, /\bDELETE\b/i, /\bLOCK\b/i, /\bFOR\s+(?:NO\s+KEY\s+)?(?:UPDATE|SHARE|KEY\s+SHARE)\b/i,
    /\bBEGIN\b/i, /\bCOMMIT\b/i, /\bROLLBACK\b/i, /\bSET\s/i, /\bTRUNCATE\b/i, /\bMERGE\b/i, /\bCALL\b/i, /;\s*\S/]) {
    expect(text, String(refused)).not.toMatch(refused);
  }
}

describe("createPostgresStorefrontObserver", () => {
  it("reads one subject's ledger with one read-only statement whose only parameter is the subject, in its own READ ONLY transaction with row security off (O1)", async () => {
    const executor = recordingExecutor([[ledgerRow({ orders: "2", payable_orders: "1", holds: "1", attempts: "2", captures: "1" })]]);
    const observer = createPostgresStorefrontObserver(executor);
    expect(observer.kind).toBe("package");
    await expect(observer.ledger("Buyer@Example.test")).resolves.toEqual({ orders: 2, payableOrders: 1, holds: 1, attempts: 2, captures: 1 });
    expect(executor.texts()).toEqual(committed);
    expect(executor.calls.filter((call) => !isRead(call.text)).every((call) => call.values === undefined || call.values.length === 0)).toBe(true);
    const read = executor.calls.find((call) => isRead(call.text))!;
    expect(read.values).toEqual(["Buyer@Example.test"]);
    expectReadOnly(read.text);
    expect(read.text.match(/\$\d+/g)?.every((placeholder) => placeholder === "$1")).toBe(true);
    for (const table of ["commerce_orders", "clients", "fulfillment_inventory_reservations", "commerce_settlement_intents",
      "payment_simulator_attempts", "payment_provider_attempts"]) expect(read.text).toContain(`public.${table}`);
  });

  it("issues one transaction per ledger read and keeps no state between reads (O1)", async () => {
    const executor = recordingExecutor([[ledgerRow({ orders: "1" })], [ledgerRow({ orders: "4" })]]);
    const observer = createPostgresStorefrontObserver(executor);
    expect((await observer.ledger("a@example.test")).orders).toBe(1);
    expect((await observer.ledger("b@example.test")).orders).toBe(4);
    expect(executor.texts()).toEqual([...committed, ...committed]);
    const reads = executor.calls.filter((call) => isRead(call.text));
    expect(reads.map((call) => call.values)).toEqual([["a@example.test"], ["b@example.test"]]);
    expect(reads[0]!.text).toBe(reads[1]!.text);
  });

  it("converts bigint text and safe integers (O2)", async () => {
    const executor = recordingExecutor([[ledgerRow({ orders: "3", payable_orders: 0, holds: "9007199254740991" })]]);
    await expect(createPostgresStorefrontObserver(executor).ledger("a@example.test"))
      .resolves.toEqual({ orders: 3, payableOrders: 0, holds: 9_007_199_254_740_991, attempts: 0, captures: 0 });
  });

  const unreadable: [string, unknown][] = [
    ["negative text", "-1"], ["text", "x"], ["beyond the safe range", "9007199254740993"], ["empty text", ""],
    ["padded text", " 3"], ["fraction text", "1.5"], ["exponent text", "1e3"], ["negative number", -1], ["fraction", 1.5],
    ["unsafe number", 2 ** 53], ["not a number", Number.NaN], ["bigint", 3n], ["null", null], ["missing", undefined],
  ];
  for (const column of ["orders", "payable_orders", "holds", "attempts", "captures"] as const) {
    it(`refuses an unreadable ${column} instead of reading zero and rolls back (O2)`, async () => {
      for (const [label, value] of unreadable) {
        const row: Record<string, unknown> = ledgerRow({ [column]: value });
        if (value === undefined) delete row[column];
        const executor = recordingExecutor([[row]]);
        await expect(createPostgresStorefrontObserver(executor).ledger("a@example.test"), `${column}: ${label}`)
          .rejects.toThrow(/^storefront_observer_count_invalid: /);
        expect(executor.texts(), `${column}: ${label}`).toEqual(rolledBack);
      }
    });
  }

  it("refuses a statement that answers no row or several rows (O2)", async () => {
    for (const rows of [[], [ledgerRow(), ledgerRow()]]) {
      const executor = recordingExecutor([rows]);
      await expect(createPostgresStorefrontObserver(executor).ledger("a@example.test")).rejects.toThrow(/^storefront_observer_count_invalid: /);
      expect(executor.texts()).toEqual(rolledBack);
    }
  });

  it("refuses a read that did not run inside its own read-only transaction with row security off (R1)", async () => {
    for (const changed of [{ row_security: "on" }, { transaction_read_only: "off" }, { row_security: undefined }, { transaction_read_only: undefined }]) {
      const executor = recordingExecutor([[{ ...ledgerRow(), ...changed }]]);
      await expect(createPostgresStorefrontObserver(executor).ledger("a@example.test"), JSON.stringify(changed))
        .rejects.toThrow(/^storefront_observer_session_invalid: .* Cause: .* Fix: .* Recheck: /);
      expect(executor.texts()).toEqual(rolledBack);
    }
  });

  it("names row-level security instead of reading filtered rows (R2)", async () => {
    const policy = Object.assign(new Error("query would be affected by row-level security policy for table \"clients\""), { code: "42501" });
    const executor = recordingExecutor([policy]);
    const refusal = createPostgresStorefrontObserver(executor).ledger("a@example.test");
    await expect(refusal).rejects.toThrow(/^storefront_observer_row_security: .* Cause: .* Fix: .*BYPASSRLS.* Recheck: /);
    expect(executor.texts()).toEqual(rolledBack);
    // Another insufficient-privilege error, such as a missing SELECT grant, passes through unchanged.
    const denied = Object.assign(new Error("permission denied for table clients"), { code: "42501" });
    await expect(createPostgresStorefrontObserver(recordingExecutor([denied])).ledger("a@example.test")).rejects.toBe(denied);
  });

  it("passes an executor's rejection through unchanged after rolling back, even when the rollback fails", async () => {
    const failure = new Error("observer_unreachable: connect failed.");
    const executor = recordingExecutor([failure]);
    await expect(createPostgresStorefrontObserver(executor).ledger("a@example.test")).rejects.toBe(failure);
    expect(executor.texts()).toEqual(rolledBack);
    const broken = recordingExecutor([failure], { ROLLBACK: new Error("connection lost") });
    await expect(createPostgresStorefrontObserver(broken).ledger("a@example.test")).rejects.toBe(failure);
    const refusedBegin = new Error("observer_unreachable: begin failed.");
    const early = recordingExecutor([], { "BEGIN READ ONLY": refusedBegin });
    await expect(createPostgresStorefrontObserver(early).ledger("a@example.test")).rejects.toBe(refusedBegin);
    expect(early.texts()).toEqual(["BEGIN READ ONLY", "ROLLBACK"]);
  });

  it("refuses a subject that is not a trimmed non-empty string before any statement (S1)", async () => {
    for (const subject of [" a@example.test", "a@example.test ", "a@example.test\n", "\ta@example.test", "", "   ", 3, null, undefined]) {
      const executor = recordingExecutor([]);
      await expect(createPostgresStorefrontObserver(executor).ledger(subject as string), JSON.stringify(subject))
        .rejects.toThrow(/^storefront_observer_input_invalid: /);
      expect(executor.calls).toEqual([]);
    }
  });

  it("adds the database payable count only for an exclusive database (O3)", async () => {
    for (const options of [undefined, {}, { exclusive: false }]) {
      const observer = createPostgresStorefrontObserver(recordingExecutor([]), options);
      expect("payableOrdersInDatabase" in observer).toBe(false);
      expect(observer.payableOrdersInDatabase).toBeUndefined();
    }
    const executor = recordingExecutor([[{ ...session, payable_orders: "5" }], [{ ...session, payable_orders: "x" }], [{ payable_orders: "5" }]]);
    const observer = createPostgresStorefrontObserver(executor, { exclusive: true });
    await expect(observer.payableOrdersInDatabase!()).resolves.toBe(5);
    expect(executor.texts()).toEqual(committed);
    const read = executor.calls.find((call) => isRead(call.text))!;
    expect(read.values ?? []).toEqual([]);
    expectReadOnly(read.text);
    expect(read.text).toContain("public.commerce_orders");
    await expect(observer.payableOrdersInDatabase!()).rejects.toThrow(/^storefront_observer_count_invalid: /);
    await expect(observer.payableOrdersInDatabase!()).rejects.toThrow(/^storefront_observer_session_invalid: /);
  });

  it("refuses an executor without query and options that are not as documented", () => {
    for (const executor of [undefined, null, {}, { query: "SELECT 1" }]) {
      expect(() => createPostgresStorefrontObserver(executor as never)).toThrow(/^storefront_observer_input_invalid: /);
    }
    for (const options of [null, "exclusive", { exclusive: "yes" }, { exclusive: 1 }]) {
      expect(() => createPostgresStorefrontObserver(recordingExecutor([]), options as never)).toThrow(/^storefront_observer_input_invalid: /);
    }
  });

  it("returns a frozen observer", () => {
    expect(Object.isFrozen(createPostgresStorefrontObserver(recordingExecutor([])))).toBe(true);
    expect(Object.isFrozen(createPostgresStorefrontObserver(recordingExecutor([]), { exclusive: true }))).toBe(true);
  });
});
