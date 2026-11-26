import { describe, expect, it, vi } from "vitest";
import {
  createPurchaseContinuation,
  toCommandKey,
  toContinuationId,
  type AttemptNumber,
  type ClientEventReporter,
  type CommandKey,
  type ContinuationId,
  type ContinuationRecord,
  type PaymentProviderFacts,
  type PendingAction,
  type PurchaseContinuationSnapshot,
  type StatusReading,
  type SubmitFailureClass,
  type SubmitOutcomeClass,
} from "../../src/storefront/index.js";
import { checkoutActivationPending, classifyCheckoutAnswer } from "./outcomeClassifierExamples.js";

type Payload = { readonly item: string; readonly email: string };
type Options = { readonly label: string };
type Request = { readonly commandKey: CommandKey; readonly attempt: AttemptNumber; readonly payload: Payload };
/** A scripted server answer. `class` is what the test classifier returns, so a test names the class directly. */
type Answer = {
  readonly class: string;
  readonly order?: string;
  readonly declines?: number | null;
  readonly activation?: boolean;
  readonly reading?: StatusReading;
};
type Purchase = { continuationId: ContinuationId; attempt: AttemptNumber; result: Answer | null; pending: PendingAction | null };
type Call = { readonly binding: string; readonly argument?: unknown; readonly options?: unknown };
type Bindings = Parameters<typeof createPurchaseContinuation<Payload, Request, Answer, Options>>[0];

/** A failure the harness classifies as `failureClass`, so a test names the class instead of an error shape. */
class Failure extends Error {
  constructor(readonly failureClass: string) {
    super(`synthetic ${failureClass}`);
  }
}

const answer = (cls: string, extra: Omit<Answer, "class"> = {}): Answer => ({ class: cls, ...extra });
const fingerprintOf = (payload: Payload) => JSON.stringify([payload.item, payload.email]);
const A: Payload = { item: "first", email: "buyer@example.test" };
const B: Payload = { item: "second", email: "buyer@example.test" };
const POLICIES = ["refuse_changed", "update_in_place"] as const;
const NOW_MS = 2_000_000_000_000;
const FIRST = "rail-first";
const SECOND = "rail-second";
const FACTS: PaymentProviderFacts = { providers: [FIRST, SECOND], reopenableEmbeddedProviders: [FIRST], retryableAttemptStatuses: ["failed"] };

let minted = 0;

/** Collects every continuation identity a world met and everything its controller handed out (W17). */
type Sink = { identities: Set<string>; handedOut: string[] };

function storedRecord(id: string, payload: Payload = A, attempt?: number): ContinuationRecord {
  const record: ContinuationRecord = { continuationId: toContinuationId(id), fingerprint: fingerprintOf(payload) };
  return attempt === undefined ? record : { ...record, attempt: attempt as AttemptNumber };
}

/** Storage shared by every controller instance of one test, as one browser's storage is shared across reloads. */
function shelf(initial: ContinuationRecord | null = null) {
  // `pin` keeps the stored fingerprint when a write keeps the identity, as a storage that drops a field would.
  return { record: initial, writes: 0, mode: "ok" as "ok" | "drop" | "throw" | "stale" | "pin" };
}
type Shelf = ReturnType<typeof shelf>;

/** The scripted server keeps one answer per command key: a command sent again under that key gets the first answer. */
function server() {
  return {
    orders: new Map<string, Answer>(),
    submits: [] as ({ answer: Answer; store?: boolean } | { lose: Failure; answer: Answer } | { fail: Error })[],
    replays: [] as Failure[],
    reads: [] as (Answer | Error | Promise<Answer>)[],
    abandons: [] as (StatusReading | Error)[],
  };
}
type Server = ReturnType<typeof server>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

function world(options: {
  shelf?: Shelf; server?: Server; policy?: string; marker?: { value: PendingAction | null; clearThrows?: Error };
  accepts?: (value: string) => boolean; overrides?: Partial<Bindings>; report?: boolean; sink?: Sink;
} = {}) {
  const calls: Call[] = [];
  const log = (binding: string, argument?: unknown, extra: Partial<Call> = {}) => { calls.push({ binding, argument, ...extra }); };
  const store = options.shelf ?? shelf();
  const srv = options.server ?? server();
  const faults: { build?: Error; classify?: Error; commandKey?: Error } = {};
  const serve = (request: Request): Answer => {
    const known = srv.orders.get(request.commandKey);
    if (known) return known;
    const step = srv.submits.shift() ?? { answer: answer("needs_client_action", { order: `order-${srv.orders.size + 1}` }) };
    if ("fail" in step) throw step.fail;
    if ("lose" in step) {
      srv.orders.set(request.commandKey, step.answer);
      throw step.lose;
    }
    if (step.store ?? step.answer.class !== "refused") srv.orders.set(request.commandKey, step.answer);
    return step.answer;
  };
  const reply = async <T>(queue: (T | Error | Promise<T>)[], name: string): Promise<T> => {
    const next = queue.shift();
    if (next === undefined) throw new Error(`no scripted ${name}`);
    if (next instanceof Error) throw next;
    return await next;
  };
  const report: ClientEventReporter = (event) => {
    log("report", event);
    options.sink?.handedOut.push(JSON.stringify(event));
  };
  const markerShelf = options.marker;
  const bindings: Bindings = {
    storage: {
      read: () => {
        log("storage.read");
        const record = store.mode === "stale" && store.writes > 0 ? storedRecord("cid-stale-other") : store.record;
        if (record) options.sink?.identities.add(record.continuationId);
        return record;
      },
      write: (record) => {
        log("storage.write", record);
        options.sink?.identities.add(record.continuationId);
        store.writes++;
        if (store.mode === "throw") throw new Error("storage write refused");
        if (store.mode === "ok") store.record = record;
        if (store.mode === "pin") {
          const kept = store.record?.continuationId === record.continuationId ? store.record.fingerprint : record.fingerprint;
          store.record = { ...record, fingerprint: kept };
        }
      },
      clear: () => {
        log("storage.clear");
        store.record = null;
      },
    },
    identifier: {
      next: () => {
        const id = `cid-${String(++minted).padStart(4, "0")}-minted`;
        options.sink?.identities.add(id);
        log("identifier.next", id);
        return id;
      },
      accepts: (value) => {
        log("identifier.accepts", value);
        return options.accepts ? options.accepts(value) : true;
      },
    },
    changedPayload: (options.policy ?? "refuse_changed") as Bindings["changedPayload"],
    commandKeyFor: (identity) => {
      log("commandKeyFor", identity);
      if (faults.commandKey) throw faults.commandKey;
      return toCommandKey(`${identity.continuationId}/${identity.attempt}`);
    },
    request: {
      fingerprint: (payload) => {
        log("fingerprint", payload);
        return fingerprintOf(payload);
      },
      build: (payload, identity) => {
        log("build", identity);
        if (faults.build) throw faults.build;
        return { commandKey: identity.commandKey, attempt: identity.attempt, payload };
      },
    },
    transport: {
      submit: async (request, requestOptions) => {
        log("submit", request, { options: requestOptions });
        return serve(request);
      },
      replay: async (request, requestOptions) => {
        log("replay", request, { options: requestOptions });
        const failure = srv.replays.shift();
        if (failure) throw failure;
        return serve(request);
      },
      read: async (purchase) => {
        log("read", { ...purchase });
        return await reply(srv.reads, "read");
      },
      abandon: async (purchase) => {
        log("abandon", { ...purchase });
        return await reply(srv.abandons, "abandon");
      },
    },
    classifySubmitFailure: (error) => {
      log("classifySubmitFailure", error);
      return (error instanceof Failure ? error.failureClass : "other") as SubmitFailureClass;
    },
    classifyOutcome: (result) => {
      log("classifyOutcome", result);
      if (faults.classify) throw faults.classify;
      return result.class as SubmitOutcomeClass;
    },
    activationPending: (result) => result.activation === true,
    declinedAttempt: (result) => result.declines ?? null,
    ...(options.report === false ? {} : { report }),
    ...(markerShelf ? {
      pending: {
        storage: {
          read: () => { log("marker.read"); return markerShelf.value; },
          write: (value: PendingAction) => { log("marker.write", value); markerShelf.value = value; },
          clear: () => {
            log("marker.clear");
            if (markerShelf.clearThrows) throw markerShelf.clearThrows;
            markerShelf.value = null;
          },
        },
        toStatusReading: (result: Answer): StatusReading => result.reading ?? { kind: "checking" },
        clock: { now: () => NOW_MS },
        providerFacts: FACTS,
      },
    } : {}),
    ...options.overrides,
  };
  const c = createPurchaseContinuation(bindings);
  const seen: PurchaseContinuationSnapshot<Answer>[] = [];
  c.subscribe((...args: unknown[]) => {
    expect(args).toEqual([]);
    seen.push(c.getSnapshot());
    options.sink?.handedOut.push(JSON.stringify(c.getSnapshot()));
  });
  const named = (binding: string) => calls.filter(call => call.binding === binding);
  return {
    c, calls, shelf: store, server: srv, faults, seen,
    count: (binding: string) => named(binding).length,
    argsOf: <T = unknown>(binding: string) => named(binding).map(call => call.argument as T),
    optionsOf: (binding: string) => named(binding).map(call => call.options),
    requests: (binding: "submit" | "replay") => named(binding).map(call => call.argument as Request),
  };
}

const attemptOf = (store: Shelf) => store.record?.attempt ?? 0;

describe.each(POLICIES)("W1 same intent, same key (%s)", policy => {
  it("presents the same command key after a lost response and a reload", async () => {
    const store = shelf(), srv = server();
    const first = world({ shelf: store, server: srv, policy });
    srv.submits.push({ lose: new Failure("timeout"), answer: answer("needs_client_action", { order: "order-1" }) });
    srv.replays.push(new Failure("timeout"));
    expect((await first.c.submit({ payload: A })).snapshot).toMatchObject({ status: "unknown", hasContinuation: true, attempt: 0 });

    const second = world({ shelf: store, server: srv, policy });
    expect((await second.c.begin()).snapshot).toMatchObject({ status: "idle", hasContinuation: true, attempt: 0 });
    expect((await second.c.submit({ payload: A })).snapshot).toMatchObject({ status: "awaiting_payment", result: { order: "order-1" } });

    const [lost] = first.requests("submit"), [continued] = second.requests("submit");
    expect(continued!.commandKey).toBe(lost!.commandKey);
    expect([lost!.attempt, continued!.attempt]).toEqual([0, 0]);
    expect(srv.orders.size).toBe(1);
  });
});

describe("W2 replay is identical", () => {
  it("replays the request object sent first and the server answers with the first order", async () => {
    const w = world();
    w.server.submits.push({ lose: new Failure("transport_uncertain"), answer: answer("needs_client_action", { order: "order-1" }) });
    const options = { label: "options" };
    const { snapshot } = await w.c.submit({ payload: A, options });
    const [sent] = w.requests("submit"), [replayed] = w.requests("replay");
    expect(replayed).toBe(sent);
    expect(w.optionsOf("replay")[0]).toBe(options);
    expect(snapshot).toMatchObject({ status: "awaiting_payment", source: "replay", outcome: "needs_client_action", result: { order: "order-1" } });
    expect(w.server.orders.size).toBe(1);
  });
});

describe("W3 changed payload refused", () => {
  it.each([["refuse_changed"], ["policy_added_later"]])("sends nothing and writes nothing under %s", async policy => {
    const record = storedRecord("cid-w3-stored");
    const store = shelf(record);
    const w = world({ shelf: store, policy });
    const { accepted, snapshot } = await w.c.submit({ payload: B });
    expect(accepted).toBe(true);
    expect(snapshot).toMatchObject({ status: "details_changed", busy: false, hasContinuation: true });
    expect(w.count("submit")).toBe(0);
    expect(w.count("build")).toBe(0);
    expect(store.writes).toBe(0);
    expect(store.record).toBe(record);
  });
});

describe("W4 changed payload after refused", () => {
  it("sends the corrected payload under the same key and stores its fingerprint", async () => {
    const w = world();
    w.server.submits.push({ answer: answer("refused") }, { answer: answer("needs_client_action", { order: "order-1" }) });
    expect((await w.c.submit({ payload: A })).snapshot.status).toBe("refused");
    expect((await w.c.submit({ payload: B })).snapshot.status).toBe("awaiting_payment");
    const [refused, corrected] = w.requests("submit");
    expect(corrected!.commandKey).toBe(refused!.commandKey);
    expect(corrected!.payload).toBe(B);
    expect(w.shelf.record?.fingerprint).toBe(fingerprintOf(B));
  });

  const C: Payload = { item: "third", email: "buyer@example.test" };
  it.each([
    ["unknown", { fail: new Failure("failure_added_later") }],
    ["in flight", { fail: new Failure("attempt_in_flight") }],
  ] as const)("(a) a changed payload sent after a refusal disarms it, so a third payload after %s is refused", async (_name, step) => {
    const w = world();
    w.server.submits.push({ answer: answer("refused") }, step);
    expect((await w.c.submit({ payload: A })).snapshot.status).toBe("refused");
    await w.c.submit({ payload: B });
    expect(w.shelf.record?.fingerprint).toBe(fingerprintOf(B));
    const { snapshot } = await w.c.submit({ payload: C });
    expect(snapshot.status).toBe("details_changed");
    expect(w.count("submit")).toBe(2);
    expect(w.shelf.record?.fingerprint).toBe(fingerprintOf(B));
  });

  it("(b) a refusal read by key does not allow a changed payload", async () => {
    const w = world();
    w.server.submits.push({ answer: answer("unknown") });
    await w.c.submit({ payload: A });
    w.server.reads.push(answer("refused"));
    expect((await w.c.resume()).snapshot.status).toBe("refused");
    const { snapshot } = await w.c.submit({ payload: B });
    expect(snapshot.status).toBe("details_changed");
    expect(w.count("submit")).toBe(1);
    expect(w.shelf.record?.fingerprint).toBe(fingerprintOf(A));
  });
});

describe("W5 update_in_place", () => {
  it("sends a changed payload under the stored key without fingerprinting it", async () => {
    const w = world({ shelf: shelf(storedRecord("cid-w5-stored")), policy: "update_in_place" });
    expect((await w.c.submit({ payload: B })).snapshot.status).toBe("awaiting_payment");
    expect(w.requests("submit").map(request => request.commandKey)).toEqual(["cid-w5-stored/0"]);
    expect(w.count("fingerprint")).toBe(0);
  });
});

describe.each(POLICIES)("W6 no attempt without a decline (%s)", policy => {
  it("keeps attempt 0 across failures, reads, a return and a reload", async () => {
    const store = shelf(), srv = server();
    let w = world({ shelf: store, server: srv, policy });
    const expectFirstAttempt = () => {
      expect(attemptOf(store)).toBe(0);
      expect(w.c.getSnapshot().attempt).toBe(0);
    };
    srv.submits.push({ fail: new Failure("timeout") });
    srv.replays.push(new Failure("timeout"));
    expect((await w.c.submit({ payload: A })).snapshot.status).toBe("unknown");
    expectFirstAttempt();
    srv.submits.push({ fail: new Failure("transport_uncertain") });
    srv.replays.push(new Failure("transport_uncertain"));
    expect((await w.c.submit({ payload: A })).snapshot.status).toBe("unknown");
    expectFirstAttempt();
    srv.submits.push({ fail: new Failure("attempt_in_flight") });
    expect((await w.c.submit({ payload: A })).snapshot).toMatchObject({ status: "awaiting_authority", source: "submit" });
    expectFirstAttempt();
    srv.submits.push({ fail: new Failure("failure_added_later") });
    expect((await w.c.submit({ payload: A })).snapshot.status).toBe("unknown");
    expectFirstAttempt();
    srv.reads.push(new Error("read failed"));
    await w.c.resume();
    expectFirstAttempt();
    w.c.recordReturn();
    expectFirstAttempt();
    w = world({ shelf: store, server: srv, policy });
    await w.c.begin();
    expectFirstAttempt();
    for (const cls of ["unknown", "refused", "awaiting_authority"]) {
      srv.reads.push(answer(cls));
      expect((await w.c.resume()).snapshot.status).toBe(cls);
      expectFirstAttempt();
    }
  });
});

describe("W7 a decline is bound to its attempt", () => {
  const declineOfFirst = answer("declined", { declines: 0 });

  it("(a) advances once for two reads of the same decline", async () => {
    const w = world();
    await w.c.submit({ payload: A });
    w.server.reads.push(declineOfFirst, declineOfFirst);
    await w.c.resume();
    expect(attemptOf(w.shelf)).toBe(1);
    expect((await w.c.resume()).snapshot).toMatchObject({ status: "declined", attempt: 1 });
    expect(attemptOf(w.shelf)).toBe(1);
  });

  it("(b) does not advance again after a reload", async () => {
    const store = shelf(), srv = server();
    const first = world({ shelf: store, server: srv });
    await first.c.submit({ payload: A });
    srv.reads.push(declineOfFirst, declineOfFirst);
    await first.c.resume();
    const reloaded = world({ shelf: store, server: srv });
    await reloaded.c.begin();
    expect((await reloaded.c.resume()).snapshot).toMatchObject({ status: "declined", attempt: 1 });
    expect(attemptOf(store)).toBe(1);
  });

  it("(c) does not advance on an old decline read after a later submit", async () => {
    const w = world();
    w.server.submits.push({ answer: declineOfFirst }, { answer: answer("awaiting_authority") });
    await w.c.submit({ payload: A });
    expect(attemptOf(w.shelf)).toBe(1);
    expect((await w.c.submit({ payload: A })).snapshot.status).toBe("awaiting_authority");
    expect(w.requests("submit").map(request => request.attempt)).toEqual([0, 1]);
    w.server.reads.push(declineOfFirst);
    expect((await w.c.resume()).snapshot).toMatchObject({ status: "declined", attempt: 1 });
    expect(attemptOf(w.shelf)).toBe(1);
  });

  it("(d) does not advance on an old decline read after a failed retry", async () => {
    const w = world();
    w.server.submits.push({ answer: declineOfFirst });
    await w.c.submit({ payload: A });
    w.faults.build = new Error("build failed");
    await expect(w.c.submit({ payload: A })).rejects.toBe(w.faults.build);
    w.server.reads.push(declineOfFirst);
    await w.c.resume();
    expect(attemptOf(w.shelf)).toBe(1);
  });

  it("(f) keeps a failed advance as the error and does not reject", async () => {
    const w = world();
    await w.c.submit({ payload: A });
    w.shelf.mode = "throw";
    w.server.reads.push(declineOfFirst);
    const { snapshot } = await w.c.resume();
    expect(snapshot).toMatchObject({ status: "declined", attempt: 0, busy: false });
    expect(snapshot.error).toEqual(new Error("storage write refused"));
    expect(attemptOf(w.shelf)).toBe(0);
  });

  it("(e) advances once for two instances reading the same decline", async () => {
    const store = shelf(storedRecord("cid-w7-shared")), srv = server();
    srv.reads.push(declineOfFirst, declineOfFirst);
    await world({ shelf: store, server: srv }).c.resume();
    await world({ shelf: store, server: srv }).c.resume();
    expect(attemptOf(store)).toBe(1);
  });
});

describe("W8 paid is absorbing", () => {
  it("stays paid through every non-settled answer and refuses submit until startOver", async () => {
    const w = world();
    w.server.submits.push({ answer: answer("settled", { order: "order-1" }) });
    expect((await w.c.submit({ payload: A })).snapshot).toMatchObject({ status: "paid", hasContinuation: false, attempt: 0 });
    expect(w.shelf.record).toBeNull();
    const firstKey = w.requests("submit")[0]!.commandKey;
    for (const late of [answer("needs_client_action"), answer("awaiting_authority"), answer("declined", { declines: 0 }),
      answer("refused"), answer("closed"), answer("unknown")]) {
      w.server.reads.push(late);
      expect((await w.c.resume()).snapshot).toMatchObject({ status: "paid", attempt: 0, result: { order: "order-1" } });
      expect(w.shelf.record).toBeNull();
    }
    expect(w.argsOf<Purchase>("read").map(read => read.continuationId)).toEqual(Array(6).fill(firstKey.split("/")[0]));
    const before = w.calls.length;
    const refused = await w.c.submit({ payload: A });
    expect(refused).toMatchObject({ accepted: false, snapshot: { status: "paid" } });
    expect(w.calls.length).toBe(before);
    expect((await w.c.startOver()).snapshot).toMatchObject({ status: "idle", hasContinuation: false, result: null });
    await w.c.submit({ payload: A });
    expect(w.count("identifier.next")).toBe(2);
    expect(w.requests("submit")[1]!.commandKey).not.toBe(firstKey);
  });
});

describe("W8 paid is absorbing when clearing fails", () => {
  it("refuses a new submit after a settled answer whose marker clear throws", async () => {
    const failure = new Error("marker clear failed");
    const marker = { value: { actionKind: "redirect", phase: "confirm_dispatched" } as PendingAction | null, clearThrows: failure };
    const w = world({ shelf: shelf(storedRecord("cid-w8-clear")), marker });
    w.server.reads.push(answer("settled"));
    await expect(w.c.resume()).rejects.toBe(failure);
    const before = w.calls.length;
    expect((await w.c.submit({ payload: A })).accepted).toBe(false);
    expect(w.calls.length).toBe(before);
  });
});

describe("W9 a return never settles", () => {
  it("waits on authority after a return and settles only on a read", async () => {
    const w = world();
    expect((await w.c.submit({ payload: A })).snapshot.status).toBe("awaiting_payment");
    w.server.reads.push(answer("settled"));
    const before = w.calls.length;
    const returned = w.c.recordReturn();
    expect(returned).toMatchObject({ accepted: true, snapshot: { status: "awaiting_authority", source: "return" } });
    expect(w.calls.length).toBe(before);
    expect((await w.c.resume()).snapshot).toMatchObject({ status: "paid", source: "read" });
  });
});

describe("W10 reload, return, resume", () => {
  it("reads by the stored identity alone", async () => {
    const w = world({ shelf: shelf(storedRecord("cid-page-one")) });
    await w.c.begin();
    w.c.recordReturn();
    w.server.reads.push(answer("awaiting_authority"));
    await w.c.resume();
    expect(w.argsOf("read")).toEqual([{ continuationId: "cid-page-one", attempt: 0, result: null, pending: null }]);
  });
});

describe("W11 unknown is safe", () => {
  it.each([["unknown"], ["class_added_later"]])("keeps the record on class %s", async cls => {
    const w = world();
    w.server.submits.push({ answer: answer(cls) });
    expect((await w.c.submit({ payload: A })).snapshot).toMatchObject({ status: "unknown", outcome: cls, hasContinuation: true });
    expect(w.shelf.record).not.toBeNull();
  });

  it.each([["unknown", "timeout"], ["null", "other"]])("keeps the record on a %s recovery", async (_kind, failureClass) => {
    const w = world();
    w.server.submits.push({ fail: new Failure(failureClass) });
    w.server.replays.push(new Failure("timeout"));
    const { snapshot } = await w.c.submit({ payload: A });
    expect(snapshot).toMatchObject({ status: "unknown", hasContinuation: true, busy: false });
    expect(snapshot.error).toBeInstanceOf(Failure);
    expect(w.shelf.record).not.toBeNull();
  });
});

describe("W12 paid, activation pending", () => {
  it("is a status only of a paid answer with a pending activation", async () => {
    const cases: [unknown, string][] = [
      [{ status: "paid" }, "paid"],
      [{ status: "paid", subscriptionActivation: { status: "active" } }, "paid"],
      [{ status: "paid", subscriptionActivation: { status: "waiting_for_mandate" } }, "paid_pending_activation"],
      [{ status: "paid", subscription: { activationStatus: "pending_payment_success" } }, "paid_pending_activation"],
      [{ status: "processing", subscriptionActivation: { status: "waiting_for_mandate" } }, "awaiting_authority"],
      [{ status: "failed" }, "declined"],
    ];
    for (const [result, status] of cases) {
      const w = world({ overrides: {
        classifyOutcome: (value) => classifyCheckoutAnswer(value),
        activationPending: (value) => checkoutActivationPending(value),
      } });
      w.server.submits.push({ answer: result as Answer });
      expect((await w.c.submit({ payload: A })).snapshot.status).toBe(status);
    }
  });
});

describe("W13 closed", () => {
  it("clears the record and the marker, sends nothing more and mints a new identity on the next submit", async () => {
    const marker = { value: { actionKind: "redirect", phase: "confirm_dispatched" } as PendingAction | null };
    const w = world({ shelf: shelf(storedRecord("cid-w13-closed")), marker });
    w.server.reads.push(answer("closed"));
    expect((await w.c.resume()).snapshot).toMatchObject({ status: "closed", hasContinuation: false, source: "read" });
    expect(w.shelf.record).toBeNull();
    expect(marker.value).toBeNull();
    const afterRead = w.calls.slice(w.calls.findIndex(call => call.binding === "read") + 1).map(call => call.binding);
    expect(afterRead.filter(binding => ["submit", "replay", "read", "abandon"].includes(binding))).toEqual([]);
    await w.c.submit({ payload: A });
    expect(w.count("identifier.next")).toBe(1);
    expect(w.requests("submit")[0]!.commandKey).not.toBe("cid-w13-closed/0");
  });
});

describe("W14 clearing", () => {
  it.each([["refused", answer("refused")], ["declined", answer("declined", { declines: 0 })], ["unknown", answer("unknown")]])(
    "keeps the record on %s", async (_name, result) => {
      const w = world();
      w.server.submits.push({ answer: result });
      await w.c.submit({ payload: A });
      expect(w.shelf.record).not.toBeNull();
    });

  it("clears on startOver only when the server answers terminal", async () => {
    const w = world();
    w.server.submits.push({ answer: answer("refused") });
    await w.c.submit({ payload: A });
    const record = w.shelf.record;
    for (const reading of [{ kind: "active" }, { kind: "checking" }, { kind: "reading_added_later" }, new Error("abandon failed")]) {
      w.server.abandons.push(reading as StatusReading | Error);
      const { snapshot } = await w.c.startOver();
      expect(snapshot).toMatchObject({ status: "refused", hasContinuation: true, busy: false });
      expect(snapshot.error).toBe(reading instanceof Error ? reading : undefined);
      expect(w.shelf.record).toBe(record);
    }
    w.server.abandons.push({ kind: "terminal" });
    expect((await w.c.startOver()).snapshot).toMatchObject({ status: "idle", hasContinuation: false, result: null, outcome: null, source: null });
    expect(w.shelf.record).toBeNull();
  });
});

describe("W15 storage", () => {
  it.each([["drop"], ["throw"], ["stale"]] as const)("sends nothing when the write mode is %s", async mode => {
    const store = shelf();
    store.mode = mode;
    const w = world({ shelf: store });
    const { snapshot } = await w.c.submit({ payload: A });
    expect(snapshot).toMatchObject({ status: "storage_unavailable", busy: false });
    expect(w.count("submit")).toBe(0);
    expect(w.count("commandKeyFor")).toBe(0);
    expect(w.count("build")).toBe(0);
    expect(snapshot.error).toEqual(mode === "throw" ? new Error("storage write refused") : undefined);
  });

  it("sends nothing when a changed fingerprint does not read back", async () => {
    const store = shelf();
    store.mode = "pin";
    const w = world({ shelf: store });
    w.server.submits.push({ answer: answer("refused") });
    await w.c.submit({ payload: A });
    const { snapshot } = await w.c.submit({ payload: B });
    expect(snapshot).toMatchObject({ status: "storage_unavailable", source: null });
    expect(w.count("submit")).toBe(1);
  });
});

describe("source of a status no answer produced", () => {
  it("is null for details_changed and storage_unavailable, and submit for a submit without an answer", async () => {
    const w = world();
    expect((await w.c.submit({ payload: A })).snapshot.source).toBe("submit");
    expect((await w.c.submit({ payload: B })).snapshot).toMatchObject({ status: "details_changed", source: null });
    w.server.reads.push(answer("needs_client_action"));
    expect((await w.c.resume()).snapshot.source).toBe("read");
    w.shelf.record = storedRecord("cid-source-stored", B);
    w.shelf.mode = "throw";
    w.server.reads.push(answer("refused"));
    w.server.submits.push({ answer: answer("refused") });
    await w.c.submit({ payload: B });
    expect((await w.c.submit({ payload: A })).snapshot).toMatchObject({ status: "storage_unavailable", source: null });
    w.shelf.mode = "ok";
    w.server.submits.push({ fail: new Failure("other") });
    expect((await w.c.submit({ payload: A })).snapshot).toMatchObject({ status: "unknown", source: "submit" });
  });
});

describe("W23 state belongs to one identity", () => {
  it("drops a refusal allowance when another instance replaced the purchase", async () => {
    const store = shelf(), srv = server();
    const first = world({ shelf: store, server: srv }), second = world({ shelf: store, server: srv });
    srv.submits.push({ answer: answer("refused") });
    expect((await first.c.submit({ payload: A })).snapshot.status).toBe("refused");
    srv.abandons.push({ kind: "terminal" });
    await second.c.startOver();
    await second.c.submit({ payload: B });
    const replaced = store.record;
    const { snapshot } = await first.c.submit({ payload: A });
    expect(snapshot).toMatchObject({ status: "details_changed", hasContinuation: true });
    expect(first.count("submit")).toBe(1);
    expect(store.record).toBe(replaced);
  });

  it("drops paid when another instance started a new purchase, and reads the new one without the old answer", async () => {
    const store = shelf(), srv = server();
    const first = world({ shelf: store, server: srv }), second = world({ shelf: store, server: srv });
    srv.submits.push({ answer: answer("settled", { order: "order-1" }) });
    expect((await first.c.submit({ payload: A })).snapshot.status).toBe("paid");
    await second.c.submit({ payload: A });
    const id = store.record!.continuationId;
    // A refused command reads nothing; the next command that reads the record learns of the new purchase.
    expect((await first.c.submit({ payload: A })).accepted).toBe(false);
    srv.reads.push(answer("awaiting_authority"));
    expect((await first.c.resume()).snapshot).toMatchObject({ status: "awaiting_authority", hasContinuation: true });
    expect(first.argsOf<Purchase>("read").at(-1)).toMatchObject({ continuationId: id, result: null });
    expect((await first.c.submit({ payload: A })).accepted).toBe(true);
  });

  it("clears only the record that names the identity it read", async () => {
    const store = shelf(storedRecord("cid-w23-first"));
    const w = world({ shelf: store });
    const read = deferred<Answer>();
    w.server.reads.push(read.promise);
    const resuming = w.c.resume();
    const replaced = storedRecord("cid-w23-second", B);
    store.record = replaced;
    read.resolve(answer("closed"));
    expect((await resuming).snapshot).toMatchObject({ status: "unknown", result: null, hasContinuation: true });
    expect(store.record).toBe(replaced);
  });
});

describe("W16 rejected identity", () => {
  it("reports, writes nothing and sends nothing", async () => {
    const store = shelf(storedRecord("cid-retired"));
    const w = world({ shelf: store, accepts: value => value !== "cid-retired" });
    expect((await w.c.submit({ payload: A })).snapshot).toMatchObject({ status: "unknown", hasContinuation: true });
    expect(w.argsOf("report")).toEqual(["stored_continuation_rejected"]);
    expect(store.writes).toBe(0);
    expect(w.count("identifier.next")).toBe(0);
    expect(w.count("submit")).toBe(0);
  });
});

describe("W18 busy refusal", () => {
  it("refuses submit while a read is in flight", async () => {
    const w = world({ shelf: shelf(storedRecord("cid-w18-read")) });
    const read = deferred<Answer>();
    w.server.reads.push(read.promise);
    const resuming = w.c.resume();
    expect(w.c.getSnapshot().busy).toBe(true);
    const before = w.calls.length;
    expect(await w.c.submit({ payload: A })).toMatchObject({ accepted: false, snapshot: { busy: true } });
    expect(w.calls.length).toBe(before);
    read.resolve(answer("awaiting_authority"));
    expect((await resuming).snapshot).toMatchObject({ status: "awaiting_authority", busy: false });
  });

  it("refuses recordReturn while begin checks a marker", async () => {
    const marker = { value: { actionKind: "none", phase: "confirm_dispatched" } as PendingAction | null };
    const w = world({ shelf: shelf(storedRecord("cid-w18-begin")), marker });
    const read = deferred<Answer>();
    w.server.reads.push(read.promise);
    const beginning = w.c.begin();
    expect(w.c.recordReturn()).toMatchObject({ accepted: false });
    read.resolve(answer("awaiting_authority", { reading: { kind: "active" } }));
    expect((await beginning).accepted).toBe(true);
  });

  it("sends one request for two submits", async () => {
    const w = world();
    const results = await Promise.all([w.c.submit({ payload: A }), w.c.submit({ payload: A })]);
    expect(results.map(result => result.accepted)).toEqual([true, false]);
    expect(w.count("submit")).toBe(1);
  });
});

describe("W19 begin only in idle", () => {
  it("refuses begin outside idle", async () => {
    const w = world();
    await w.c.submit({ payload: A });
    const before = w.calls.length;
    expect(await w.c.begin()).toMatchObject({ accepted: false, snapshot: { status: "awaiting_payment" } });
    expect(w.calls.length).toBe(before);
  });
});

describe("W20 notifications", () => {
  it("notifies with a new frozen object, stays stable between changes and skips refused and unchanged commands", async () => {
    const w = world();
    const initial = w.c.getSnapshot();
    expect(initial).toStrictEqual({ status: "idle", busy: false, hasContinuation: false, attempt: 0, result: null, outcome: null,
      source: null, resumeDecision: null, error: undefined });
    expect(Object.isFrozen(initial)).toBe(true);
    expect(w.c.getSnapshot()).toBe(initial);
    await w.c.submit({ payload: A });
    expect(w.seen.length).toBeGreaterThanOrEqual(2);
    for (const [index, snapshot] of w.seen.entries()) {
      expect(Object.isFrozen(snapshot)).toBe(true);
      expect(snapshot).not.toBe(index === 0 ? initial : w.seen[index - 1]);
    }
    expect(w.c.getSnapshot()).toBe(w.seen.at(-1));
    const count = w.seen.length;
    await w.c.begin();
    w.c.recordReturn();
    const returned = w.seen.length;
    expect(returned).toBe(count + 1);
    w.c.recordReturn();
    expect(w.seen.length).toBe(returned);
  });

  it("calls each current listener once in order and honours unsubscribes, during a notification too", async () => {
    const w = world();
    const order: string[] = [];
    const repeated = () => order.push("repeated");
    const firstRepeat = w.c.subscribe(repeated);
    w.c.subscribe(repeated);
    let stopLater = () => {};
    w.c.subscribe(() => { order.push("first"); stopLater(); });
    stopLater = w.c.subscribe(() => order.push("later"));
    firstRepeat();
    firstRepeat();
    w.c.recordReturn();
    expect(order).toEqual(["repeated", "first"]);
    const stopped = w.c.subscribe(() => order.push("stopped"));
    stopped();
    expect((await w.c.startOver()).snapshot.status).toBe("idle");
    expect(order).toEqual(["repeated", "first", "repeated", "first"]);
  });

  it("isolates a listener's error and surfaces it as an unhandled rejection", () => {
    const w = world();
    const failure = new Error("listener failed");
    const reached: string[] = [];
    w.c.subscribe(() => { throw failure; });
    w.c.subscribe(() => reached.push("next"));
    const reject = vi.spyOn(Promise, "reject").mockImplementation(() => Promise.resolve() as never);
    let surfaced: unknown[][];
    try {
      expect(w.c.recordReturn().accepted).toBe(true);
      surfaced = [...reject.mock.calls];
    } finally {
      reject.mockRestore();
    }
    expect(reached).toEqual(["next"]);
    expect(surfaced).toEqual([[failure]]);
  });
});

describe("W21 errors release busy", () => {
  it.each([["build"], ["classify"], ["commandKey"]] as const)("rejects with the %s error and leaves busy false", async fault => {
    const w = world();
    const error = new Error(`${fault} failed`);
    w.faults[fault] = error;
    await expect(w.c.submit({ payload: A })).rejects.toBe(error);
    expect(w.c.getSnapshot()).toMatchObject({ status: "idle", busy: false, error: undefined, result: null });
  });
});

describe("W22 pending-action check", () => {
  type Row = {
    name: string; marker: PendingAction; reading: StatusReading;
    beginStatus: string; halts: boolean; kept: boolean; decision: unknown;
  };
  const rows: Row[] = [
    { name: "discard", marker: { actionKind: "none", phase: "action_issued" }, reading: { kind: "terminal" },
      beginStatus: "idle", halts: false, kept: false, decision: "discard" },
    { name: "no_action_keep_marker", marker: { actionKind: "none", phase: "action_issued" }, reading: { kind: "active" },
      beginStatus: "idle", halts: false, kept: true, decision: "no_action_keep_marker" },
    { name: "unknown", marker: { actionKind: "none", phase: "action_issued" }, reading: { kind: "checking" },
      beginStatus: "unknown", halts: true, kept: true, decision: "unknown" },
    { name: "wait_on_status", marker: { actionKind: "none", phase: "confirm_dispatched" }, reading: { kind: "checking" },
      beginStatus: "awaiting_authority", halts: true, kept: true, decision: "wait_on_status" },
    { name: "follow_redirect", marker: { actionKind: "redirect" }, reading: { kind: "active", action: { kind: "redirect", url: "https://pay.example/next" } },
      beginStatus: "awaiting_payment", halts: true, kept: true, decision: { kind: "follow_redirect", url: "https://pay.example/next" } },
    { name: "reopen_embedded", marker: { actionKind: "embedded" }, reading: { kind: "active", action: { kind: "embedded", provider: FIRST, actionToken: "action-1" } },
      beginStatus: "awaiting_payment", halts: true, kept: true, decision: { kind: "reopen_embedded", actionToken: "action-1" } },
  ];
  const setup = (marker: PendingAction) => {
    const holder = { value: marker as PendingAction | null };
    return { holder, w: world({ shelf: shelf(storedRecord("cid-w22-pending")), marker: holder }) };
  };

  it.each(rows)("$name through begin", async row => {
    const { holder, w } = setup(row.marker);
    w.server.reads.push(answer("awaiting_authority", { reading: row.reading }));
    const { snapshot } = await w.c.begin();
    expect(snapshot).toMatchObject({ status: row.beginStatus, busy: false, resumeDecision: row.decision, hasContinuation: true });
    expect(holder.value).toBe(row.kept ? row.marker : null);
    expect(w.count("read")).toBe(1);
    expect(w.argsOf("read")[0]).toEqual({ continuationId: "cid-w22-pending", attempt: 0, result: null, pending: row.marker });
    expect(w.count("submit")).toBe(0);
  });

  it.each(rows)("$name through submit", async row => {
    const { holder, w } = setup(row.marker);
    w.server.reads.push(answer("awaiting_authority", { reading: row.reading }));
    const { snapshot } = await w.c.submit({ payload: A });
    expect(w.count("read")).toBe(1);
    expect(holder.value).toBe(row.kept ? row.marker : null);
    if (row.halts) {
      expect(w.count("submit")).toBe(0);
      expect(snapshot).toMatchObject({ status: row.beginStatus, resumeDecision: row.decision });
    } else {
      expect(w.count("submit")).toBe(1);
      expect(snapshot).toMatchObject({ status: "awaiting_payment", source: "submit", resumeDecision: null });
    }
  });

  it("blocks a switched provider from submit but not from begin", async () => {
    const marker: PendingAction = { actionKind: "none", phase: "action_issued" };
    const reading: StatusReading = { kind: "active", payment: { provider: FIRST, attemptStatus: null } };
    const begun = setup(marker);
    begun.w.server.reads.push(answer("awaiting_authority", { reading }));
    expect((await begun.w.c.begin()).snapshot).toMatchObject({ status: "idle", resumeDecision: "no_action_keep_marker" });
    const submitted = setup(marker);
    submitted.w.server.reads.push(answer("awaiting_authority", { reading }));
    const { snapshot } = await submitted.w.c.submit({ payload: A, selectedProvider: SECOND });
    expect(snapshot).toMatchObject({ status: "awaiting_payment",
      resumeDecision: { kind: "blocked_by_prior_attempt", provider: FIRST, actionToken: null } });
    expect(submitted.w.count("submit")).toBe(0);
    expect(submitted.holder.value).toBe(marker);
  });

  it("reads nothing for an expired marker and continues the submit", async () => {
    const { holder, w } = setup({ actionKind: "embedded", phase: "confirm_dispatched", expiresAt: NOW_MS / 1000 - 1 });
    const { snapshot } = await w.c.submit({ payload: A });
    expect(w.count("read")).toBe(0);
    expect(w.count("submit")).toBe(1);
    expect(snapshot.status).toBe("awaiting_payment");
    expect(holder.value).not.toBeNull();
  });

  it("applies a settled read and sends no create request", async () => {
    const { holder, w } = setup({ actionKind: "embedded", phase: "confirm_dispatched" });
    w.server.reads.push(answer("settled", { reading: { kind: "active" } }));
    const { snapshot } = await w.c.submit({ payload: A });
    expect(snapshot).toMatchObject({ status: "paid", source: "read", resumeDecision: null, hasContinuation: false });
    expect(holder.value).toBeNull();
    expect(w.count("submit")).toBe(0);
    expect(w.count("read")).toBe(1);
  });

  it("treats a rejected read as checking and keeps the error", async () => {
    const { holder, w } = setup({ actionKind: "none", phase: "action_issued" });
    const failure = new Error("status unreadable");
    w.server.reads.push(failure);
    const { snapshot } = await w.c.submit({ payload: A });
    expect(snapshot).toMatchObject({ status: "unknown", resumeDecision: "unknown", busy: false });
    expect(snapshot.error).toBe(failure);
    expect(w.count("submit")).toBe(0);
    expect(holder.value).not.toBeNull();
  });
});

describe("W17 no identifier leaks", () => {
  it("never hands a continuation identifier to a listener, a snapshot or the reporter", async () => {
    const sink: Sink = { identities: new Set(), handedOut: [] };
    // A lost response and its replay, a refusal and a changed payload, a decline read by key.
    const first = world({ sink });
    first.server.submits.push({ lose: new Failure("timeout"), answer: answer("refused") }, { answer: answer("needs_client_action") });
    await first.c.submit({ payload: A });
    await first.c.submit({ payload: B });
    first.server.reads.push(answer("declined", { declines: 0 }));
    await first.c.resume();
    first.c.recordReturn();
    // Paid, then a new purchase after startOver, then a closed read.
    const paid = world({ sink });
    paid.server.submits.push({ answer: answer("settled") });
    await paid.c.submit({ payload: A });
    await paid.c.startOver();
    await paid.c.submit({ payload: A });
    paid.server.reads.push(answer("closed"));
    await paid.c.resume();
    // A stored identity the host will not reuse, a storage failure, and startOver answers.
    await world({ sink, shelf: shelf(storedRecord("cid-w17-retired")), accepts: () => false }).c.submit({ payload: A });
    const broken = shelf();
    broken.mode = "throw";
    await world({ sink, shelf: broken }).c.submit({ payload: A });
    const over = world({ sink, shelf: shelf(storedRecord("cid-w17-over")) });
    over.server.abandons.push({ kind: "active" }, new Error("abandon failed"), { kind: "terminal" });
    for (let index = 0; index < 3; index++) await over.c.startOver();
    // The pending-action check, halting on a switched provider.
    const marked = world({ sink, shelf: shelf(storedRecord("cid-w17-marked")),
      marker: { value: { actionKind: "none", phase: "action_issued" } } });
    marked.server.reads.push(answer("awaiting_authority", { reading: { kind: "active", payment: { provider: FIRST, attemptStatus: null } } }));
    await marked.c.submit({ payload: A, selectedProvider: SECOND });
    for (const id of ["cid-w17-retired", "cid-w17-over", "cid-w17-marked"]) sink.identities.add(id);

    expect(sink.identities.size).toBeGreaterThanOrEqual(6);
    expect(sink.handedOut.some(text => text.includes("stored_continuation_rejected"))).toBe(true);
    expect(sink.handedOut.length).toBeGreaterThan(20);
    const leaks = sink.handedOut.filter(text => [...sink.identities].some(id => text.includes(id)));
    expect(leaks).toEqual([]);
  });
});
