import type { ClientEventReporter, SubmitFailureClassifier, SubmitTransportBinding } from "./bindings.js";

/** How long, in milliseconds, the package asks the transport to wait for the one replay. */
const REPLAY_DEADLINE_MS = 10_000;

/**
 * What `recoverAmbiguousSubmit` learned about a failed submit.
 *
 * - `recovered`: the one replay succeeded; `response` is the transport's.
 * - `no_stable_identity`: the submit may have committed, but there is no
 *   retained request or it carries no command key, so nothing was sent.
 * - `in_flight`: the server refused because an attempt for this purchase is
 *   already in flight, on the first submit or on the replay.
 * - `unknown`: the replay failed for any other reason; nothing more was sent.
 */
export type AmbiguousSubmitRecovery<TResponse> =
  | { kind: "recovered"; response: TResponse }
  | { kind: "no_stable_identity" }
  | { kind: "in_flight" }
  | { kind: "unknown" };

/**
 * Decides what a failed submit means and replays it, at most once, when the
 * server may have committed it.
 *
 * It calls `classifySubmitFailure` once on `error`:
 *
 * - `attempt_in_flight`: calls `report("submit_refused_in_flight")` once when
 *   `report` is bound, sends nothing and returns `in_flight`, with or without a
 *   request.
 * - `timeout` or `transport_uncertain`: with no `request`, returns
 *   `no_stable_identity` without calling `transport.commandKey`. When
 *   `commandKey(request)` is falsy, returns `no_stable_identity` and sends
 *   nothing. Otherwise calls `transport.replay` once with the same `request`
 *   object, unmodified, the caller's `options` and a deadline of 10 000 ms,
 *   and returns `recovered` with its response. When the replay fails, it
 *   classifies that error once and returns `in_flight` for
 *   `attempt_in_flight` and `unknown` for any other class, reporting nothing
 *   and sending nothing more.
 * - `other`, or a class this version does not know: returns `null` and sends
 *   nothing. An unrecognized class is never replayed.
 *
 * `deadlineMs` is a duration the package asks for; whether it is enforced is
 * the transport's. An error that the classifier, `commandKey` or the reporter
 * raises propagates unchanged.
 */
export async function recoverAmbiguousSubmit<TRequest, TOptions, TResponse>(
  bindings: {
    transport: SubmitTransportBinding<TRequest, TOptions, TResponse>;
    classifySubmitFailure: SubmitFailureClassifier;
    /**
     * Receives the in-flight refusal of the first submit, if bound.
     *
     * @experimental
     */
    report?: ClientEventReporter;
  },
  input: { error: unknown; request: TRequest | null; options: TOptions },
): Promise<AmbiguousSubmitRecovery<TResponse> | null> {
  const failureClass = bindings.classifySubmitFailure(input.error);
  if (failureClass === "attempt_in_flight") {
    bindings.report?.("submit_refused_in_flight");
    return { kind: "in_flight" };
  }
  if (failureClass !== "timeout" && failureClass !== "transport_uncertain") return null;

  const request = input.request;
  if (request === null || !bindings.transport.commandKey(request)) return { kind: "no_stable_identity" };

  try {
    const response = await bindings.transport.replay(request, input.options, REPLAY_DEADLINE_MS);
    return { kind: "recovered", response };
  } catch (error) {
    if (bindings.classifySubmitFailure(error) === "attempt_in_flight") return { kind: "in_flight" };
    return { kind: "unknown" };
  }
}
