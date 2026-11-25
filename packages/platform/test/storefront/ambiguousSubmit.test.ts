import { describe, expect, it } from "vitest";
import {
  recoverAmbiguousSubmit,
  toCommandKey,
  type AmbiguousSubmitRecovery,
  type ClientEventReporter,
  type CommandKey,
  type SubmitFailureClass,
  type SubmitFailureClassifier,
  type SubmitTransportBinding,
} from "../../src/storefront/index.js";

type Request = { key: string | null };
type Options = { signal?: string } | null;
type Response = { settled: true };
type Call =
  | { binding: "classify"; argument: unknown }
  | { binding: "commandKey"; argument: Request }
  | { binding: "replay"; request: Request; options: Options; deadlineMs: number }
  | { binding: "report"; argument: string };

/** A failure the harness classifies as `failureClass`, so a test names the class instead of an error shape. */
class Failure extends Error {
  constructor(readonly failureClass: string) {
    super(`synthetic ${failureClass}`);
  }
}

const RESPONSE: Response = { settled: true };

/**
 * In-memory bindings that record every call, in order, across classifier,
 * transport and reporter. `replayFails` makes the replay reject with that class.
 */
function harness(options: { replayFails?: string; report?: boolean } = {}) {
  const calls: Call[] = [];
  const classifySubmitFailure: SubmitFailureClassifier = (error) => {
    calls.push({ binding: "classify", argument: error });
    // A class value outside the union reaches the package unchanged.
    return (error as Failure).failureClass as SubmitFailureClass;
  };
  const transport: SubmitTransportBinding<Request, Options, Response> = {
    commandKey: (request) => {
      calls.push({ binding: "commandKey", argument: request });
      return request.key === null ? undefined : toCommandKey(request.key);
    },
    replay: async (request, replayOptions, deadlineMs) => {
      calls.push({ binding: "replay", request, options: replayOptions, deadlineMs });
      if (options.replayFails !== undefined) throw new Failure(options.replayFails);
      return RESPONSE;
    },
  };
  const report: ClientEventReporter = (event) => {
    calls.push({ binding: "report", argument: event });
  };
  return {
    calls,
    bindings: options.report === false ? { transport, classifySubmitFailure } : { transport, classifySubmitFailure, report },
  };
}

const keyed = (): Request => ({ key: "command-1" });

describe("recoverAmbiguousSubmit", () => {
  it("reports an in-flight refusal once and sends nothing", async () => {
    const { bindings, calls } = harness();
    const error = new Failure("attempt_in_flight");

    await expect(recoverAmbiguousSubmit(bindings, { error, request: keyed(), options: null })).resolves.toStrictEqual({ kind: "in_flight" });

    expect(calls).toEqual([{ binding: "classify", argument: error }, { binding: "report", argument: "submit_refused_in_flight" }]);
  });

  it("reports an in-flight refusal without a request and without calling commandKey", async () => {
    const { bindings, calls } = harness();

    await expect(recoverAmbiguousSubmit(bindings, { error: new Failure("attempt_in_flight"), request: null, options: null }))
      .resolves.toStrictEqual({ kind: "in_flight" });

    expect(calls.map(call => call.binding)).toEqual(["classify", "report"]);
  });

  it("returns in_flight without a reporter bound", async () => {
    const { bindings, calls } = harness({ report: false });

    await expect(recoverAmbiguousSubmit(bindings, { error: new Failure("attempt_in_flight"), request: keyed(), options: null }))
      .resolves.toStrictEqual({ kind: "in_flight" });

    expect(calls.map(call => call.binding)).toEqual(["classify"]);
  });

  it.each(["timeout", "transport_uncertain"])("returns no_stable_identity for %s without a request and never calls commandKey", async (failureClass) => {
    const { bindings, calls } = harness();

    await expect(recoverAmbiguousSubmit(bindings, { error: new Failure(failureClass), request: null, options: null }))
      .resolves.toStrictEqual({ kind: "no_stable_identity" });

    expect(calls.map(call => call.binding)).toEqual(["classify"]);
  });

  it.each(["timeout", "transport_uncertain"])("returns no_stable_identity for %s with a run-time undefined request and calls neither commandKey nor replay", async (failureClass) => {
    const { bindings, calls } = harness();
    // An untyped caller may pass `undefined`; it counts as no request.
    const request = undefined as unknown as null;

    await expect(recoverAmbiguousSubmit(bindings, { error: new Failure(failureClass), request, options: null }))
      .resolves.toStrictEqual({ kind: "no_stable_identity" });

    expect(calls.map(call => call.binding)).toEqual(["classify"]);
  });

  it.each([
    ["no key", null],
    ["an empty key", ""],
  ])("returns no_stable_identity and sends nothing for a request with %s", async (_label, key) => {
    for (const failureClass of ["timeout", "transport_uncertain"]) {
      const { bindings, calls } = harness();

      await expect(recoverAmbiguousSubmit(bindings, { error: new Failure(failureClass), request: { key }, options: null }))
        .resolves.toStrictEqual({ kind: "no_stable_identity" });

      expect(calls.map(call => call.binding)).toEqual(["classify", "commandKey"]);
    }
  });

  it.each(["timeout", "transport_uncertain"])("replays the identical request once for %s with a 10 second deadline", async (failureClass) => {
    const { bindings, calls } = harness();
    const request = keyed();
    const options = { signal: "caller" };

    const result: AmbiguousSubmitRecovery<Response> | null = await recoverAmbiguousSubmit(bindings, { error: new Failure(failureClass), request, options });

    expect(result).toStrictEqual({ kind: "recovered", response: RESPONSE });
    expect(calls.map(call => call.binding)).toEqual(["classify", "commandKey", "replay"]);
    const replay = calls[2] as Extract<Call, { binding: "replay" }>;
    expect(replay.request).toBe(request);
    expect(replay.request).toStrictEqual({ key: "command-1" });
    expect(replay.options).toBe(options);
    expect(replay.options).toStrictEqual({ signal: "caller" });
    expect(replay.deadlineMs).toBe(10_000);
  });

  it("passes null options to the replay unchanged", async () => {
    const { bindings, calls } = harness();

    await recoverAmbiguousSubmit(bindings, { error: new Failure("timeout"), request: keyed(), options: null });

    expect(calls.find(call => call.binding === "replay")).toMatchObject({ options: null, deadlineMs: 10_000 });
  });

  it("returns in_flight and reports nothing when the replay fails with attempt_in_flight", async () => {
    const { bindings, calls } = harness({ replayFails: "attempt_in_flight" });

    await expect(recoverAmbiguousSubmit(bindings, { error: new Failure("transport_uncertain"), request: keyed(), options: null }))
      .resolves.toStrictEqual({ kind: "in_flight" });

    expect(calls.map(call => call.binding)).toEqual(["classify", "commandKey", "replay", "classify"]);
  });

  it.each(["timeout", "transport_uncertain", "other", "a_class_this_version_does_not_know"])(
    "returns unknown and sends nothing more when the replay fails with %s",
    async (replayClass) => {
      const { bindings, calls } = harness({ replayFails: replayClass });

      await expect(recoverAmbiguousSubmit(bindings, { error: new Failure("timeout"), request: keyed(), options: null }))
        .resolves.toStrictEqual({ kind: "unknown" });

      expect(calls.map(call => call.binding)).toEqual(["classify", "commandKey", "replay", "classify"]);
      expect(calls[3]).toMatchObject({ binding: "classify", argument: { failureClass: replayClass } });
    },
  );

  it("returns null and sends nothing for other", async () => {
    const { bindings, calls } = harness();

    await expect(recoverAmbiguousSubmit(bindings, { error: new Failure("other"), request: keyed(), options: null })).resolves.toBeNull();

    expect(calls.map(call => call.binding)).toEqual(["classify"]);
  });

  it.each(["a_class_this_version_does_not_know", "", "TIMEOUT"])("returns null and never replays a class it does not know: %j", async (failureClass) => {
    const { bindings, calls } = harness();

    await expect(recoverAmbiguousSubmit(bindings, { error: new Failure(failureClass), request: keyed(), options: null })).resolves.toBeNull();

    expect(calls.map(call => call.binding)).toEqual(["classify"]);
  });

  it("propagates a throwing classifier as the same object and sends nothing", async () => {
    const { bindings, calls } = harness();
    const refusal = new Error("classifier refused");
    const throwing = { ...bindings, classifySubmitFailure: (): SubmitFailureClass => { throw refusal; } };

    await expect(recoverAmbiguousSubmit(throwing, { error: new Failure("timeout"), request: keyed(), options: null })).rejects.toBe(refusal);

    expect(calls).toEqual([]);
  });

  it("propagates a throwing commandKey or reporter as the same object", async () => {
    const keyRefusal = new Error("commandKey refused");
    const keyHarness = harness();
    const transport = { ...keyHarness.bindings.transport, commandKey: (): CommandKey => { throw keyRefusal; } };
    await expect(recoverAmbiguousSubmit({ ...keyHarness.bindings, transport }, { error: new Failure("timeout"), request: keyed(), options: null }))
      .rejects.toBe(keyRefusal);
    expect(keyHarness.calls.map(call => call.binding)).toEqual(["classify"]);

    const reportRefusal = new Error("reporter refused");
    const reportHarness = harness();
    const report = () => { throw reportRefusal; };
    await expect(recoverAmbiguousSubmit({ ...reportHarness.bindings, report }, { error: new Failure("attempt_in_flight"), request: keyed(), options: null }))
      .rejects.toBe(reportRefusal);
  });
});
