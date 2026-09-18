import { describe, expect, it } from "vitest";
import { operatorCommandFailure } from "./customerSupportCommandResponses.ts";
import { OperatorSubscriptionAuthorityUnavailableError } from "../../../domains/support/customerRecoveryCommand.ts";
import {
  CustomerSupportCommandIdempotencyConflictError,
  CustomerSupportCommandInvalidError,
} from "../../../domains/support/customerRecoveryCommand.ts";
import { CustomerSupportOperatorInactiveError, CustomerSupportOperatorNotProvisionedError } from "../../../runtime/support/customerJourneyBinding.ts";

const FALLBACK = "customer_support_subscription_command_failed";

describe("operatorCommandFailure", () => {
  // The historical failure mode: the routine was deployed and applied, but the API
  // layer had not reloaded its schema cache, so every operator command answered as an anonymous
  // upstream failure. Reads kept working because they go to table endpoints, which
  // made it look like the command surface itself was broken.
  it("maps a schema-cache miss at the API layer to a named authority failure", () => {
    const error = operatorCommandFailure(
      { code: "PGRST202", message: "Could not find the function public.customer_support_apply_subscription_action_v1 in the schema cache" },
      FALLBACK,
    );
    expect(error).toBeInstanceOf(OperatorSubscriptionAuthorityUnavailableError);
  });

  it("maps the message alone when no code arrives", () => {
    expect(operatorCommandFailure({ message: "Could not find the function public.x" }, FALLBACK))
      .toBeInstanceOf(OperatorSubscriptionAuthorityUnavailableError);
  });

  // Direct SQL answers 42883 for the same absence; the API layer is not the only
  // caller, so both spellings of "this routine is not reachable" resolve alike.
  it("maps undefined_function from direct SQL the same way", () => {
    expect(operatorCommandFailure({ code: "42883" }, FALLBACK))
      .toBeInstanceOf(OperatorSubscriptionAuthorityUnavailableError);
  });

  it("still maps the three faults it always did", () => {
    expect(operatorCommandFailure({ code: "42501" }, FALLBACK)).toBeInstanceOf(CustomerSupportOperatorInactiveError);
    expect(operatorCommandFailure({ code: "22023" }, FALLBACK)).toBeInstanceOf(CustomerSupportCommandInvalidError);
    expect(operatorCommandFailure({ code: "23505" }, FALLBACK)).toBeInstanceOf(CustomerSupportCommandIdempotencyConflictError);
  });

  // The ledger `operator_id` foreign key, reachable since #2846 made the eligibility gate
  // a union of the admin roster and `platform_communication_operators`: a principal the
  // roster arm admits has no row for the receipt to reference. The scope refuses this
  // before anything mutates when a command intent is declared; this arm is the backstop
  // for a caller that declares none, so the fault is still named and not a bare 503.
  it("names the missing operator row instead of leaving a foreign-key violation opaque", () => {
    expect(operatorCommandFailure({ code: "23503" }, FALLBACK))
      .toBeInstanceOf(CustomerSupportOperatorNotProvisionedError);
    expect(operatorCommandFailure({
      message: 'insert or update on table "customer_support_subscription_commands" violates foreign key constraint "customer_support_subscription_commands_operator_id_fkey"'
        + " - Key (operator_id) is not present in table \"platform_communication_operators\".",
    }, FALLBACK)).toBeInstanceOf(CustomerSupportOperatorNotProvisionedError);
  });

  // An unrecognized failure stays opaque on purpose, but it no longer arrives
  // nameless: the SQLSTATE travels with it, which is the difference between an hour
  // of guesswork and one look at a log line.
  it("carries the unknown code into the fallback instead of discarding it", () => {
    expect(operatorCommandFailure({ code: "40001" }, FALLBACK).message).toBe(`${FALLBACK}: 40001`);
    expect(operatorCommandFailure({}, FALLBACK).message).toBe(`${FALLBACK}: unknown`);
  });
});
