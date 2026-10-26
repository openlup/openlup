import { expect, it, vi } from "vitest";
import { linkThenApply, moveIdentityForEmailCorrection, OperatorIdentityMoveRefusedError, executeOperatorAccountLink,
  createOperatorRecovery } from "../../src/account-support/operatorRecovery.js";
import type { ManagedOperatorAuthorityPort, OperatorEmailCorrectionExecution, OperatorEmailCorrectionSettlement } from "../../src/account-support/contracts/index.js";

const admission = { outcome: "admitted", authUserId: "identity-a", originalEmail: "old@example.invalid", newEmail: "new@example.invalid" } as const;
const execution = { ...admission, outcome: "claimed", idempotencyKey: "email-key", claimToken: "claim-a", sequence: "19" } as const;
const applied = { outcome: "applied", authUserLinked: true } as const;

it("admits then claims before lazy read/move/read/settle and preserves claim attribution", async () => {
  const events: string[] = [];
  const authority = {
    correctSubjectEmail: async () => { events.push("admit"); return admission; },
    claimSubjectEmail: async () => { events.push("claim"); return execution; },
    settleSubjectEmail: async (input: unknown) => {
      events.push("settle"); expect(input).toEqual({ idempotencyKey: execution.idempotencyKey, claimToken: execution.claimToken, phase: "complete" }); return applied;
    },
  } as unknown as ManagedOperatorAuthorityPort;
  let email = admission.originalEmail as string;
  const binding = createOperatorRecovery({ graph: "managed", authority, accountLink: {} as never, identity: () => {
    events.push("identity"); return {
      findClientHoldingEmail: async () => null,
      readIdentityEmail: async id => { expect(id).toBe("identity-a"); events.push("read"); return email; },
      moveIdentityEmail: async (id, next, claim) => { events.push("move"); expect(id).toBe("identity-a");
        expect(claim).toEqual({ idempotencyKey: "email-key", claimToken: "claim-a", sequence: "19" }); email = next; },
    };
  } });
  expect(await binding.execute({ actor: { operatorId: "original-operator", role: "admin", isMachineActor: false, graph: "managed" },
    subject: { subjectId: "subject-a" }, command: { action: "correct_email", subjectId: "subject-a", expectedEmail: admission.originalEmail,
      newEmail: admission.newEmail, idempotencyKey: "email-key" }, reason: "requested", idempotencyKey: "email-key", expectedVersion: null, evidence: [] })).toBe(applied);
  expect(events).toEqual(["admit", "claim", "identity", "read", "move", "read", "settle"]);
});
it.each([
  ["pending", "customer_support_email_correction_in_progress"],
  ["failed", "customer_support_email_correction_failed"],
] as const)("preserves %s claim outcome without identity effects", async (outcome, failure) => {
  const identity = vi.fn(); const settle = vi.fn();
  await expect(moveIdentityForEmailCorrection({ admission, claim: async () => ({ outcome }), identity, settle })).rejects.toThrow(failure);
  expect(identity).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
});
it.each(["admission", "claim"] as const)("terminal %s bypasses identity and settlement by identity", async stage => {
  const terminal = { outcome: "replayed", authUserLinked: true } as const;
  const claim = vi.fn(async (): Promise<OperatorEmailCorrectionExecution> => terminal);
  const identity = vi.fn(); const settle = vi.fn();
  expect(await moveIdentityForEmailCorrection({ admission: stage === "admission" ? terminal : admission, claim, identity, settle })).toBe(terminal);
  expect(claim).toHaveBeenCalledTimes(stage === "admission" ? 0 : 1);
  expect(identity).not.toHaveBeenCalled(); expect(settle).not.toHaveBeenCalled();
});
it.each([
  ["uncertain", "release", { outcome: "pending" }, "customer_support_email_correction_repair_required"],
  ["refused", "fail", { outcome: "failed" }, "customer_support_email_correction_failed"],
] as const)("settles %s identity failure through %s", async (kind, phase, settlement, message) => {
  const settle = vi.fn(async (): Promise<OperatorEmailCorrectionSettlement> => settlement);
  await expect(moveIdentityForEmailCorrection({ admission, claim: async () => execution, settle,
    identity: () => ({ findClientHoldingEmail: async () => null, readIdentityEmail: async () => admission.originalEmail,
      moveIdentityEmail: async () => { throw kind === "refused" ? new OperatorIdentityMoveRefusedError() : new Error("uncertain"); } }),
  })).rejects.toThrow(message);
  expect(settle).toHaveBeenCalledExactlyOnceWith(phase, execution);
});
it("recovers an already committed identity move without moving it twice", async () => {
  const move = vi.fn();
  expect(await moveIdentityForEmailCorrection({ admission, claim: async () => execution, settle: async () => applied,
    identity: () => ({ findClientHoldingEmail: async () => null, readIdentityEmail: async () => admission.newEmail, moveIdentityEmail: move }),
  })).toBe(applied); expect(move).not.toHaveBeenCalled();
});
it.each(["refused", "transport", "applied"] as const)("link then %s keeps callback before the second independent command", async outcome => {
  const events: string[] = []; const linked = { outcome: "applied" } as const;
  const subscription = outcome === "refused" ? { outcome: "refused", refusalCode: "payment_blocked" } as const
    : { outcome: "applied", subscriptionStatus: "active", nextCycleAt: null, templateVersion: 2, eventId: "event", appliedBy: null } as const;
  const result = await linkThenApply({ link: async () => { events.push("link-key"); return linked; },
    onLinked: function (this: unknown) { expect(this).toBeUndefined(); events.push("callback"); return new Promise(() => {}); },
    apply: async () => { events.push("action-key"); if (outcome === "transport") throw new Error("unavailable"); return subscription; } });
  expect(events).toEqual(["link-key", "callback", "action-key"]);
  expect(result).toEqual({ outcome: outcome === "applied" ? "completed" : "partial", link: linked,
    subscription: outcome === "transport" ? null : subscription });
});
it("link refusal stops the callback and second command", async () => {
  const linked = { outcome: "conflict", refusalCode: "email_expectation_conflict" } as const;
  const apply = vi.fn(); const onLinked = vi.fn();
  expect(await linkThenApply({ link: async () => linked, apply, onLinked })).toEqual({ outcome: "link_refused", link: linked });
  expect(apply).not.toHaveBeenCalled(); expect(onLinked).not.toHaveBeenCalled();
});
it.each([true, false])("resolves only an eligible stored identity (linked=%s)", async linked => {
  const resolve = vi.fn(async () => "resolved"); const write = vi.fn(async () => ({ outcome: "noop" } as const));
  const result = await executeOperatorAccountLink({ command: { action: "link_account", subjectId: "subject", expectedEmail: " A@EXAMPLE.INVALID ", idempotencyKey: "link-key" },
    operatorId: "operator", identity: { findSubject: async () => ({ identityKind: "customer", email: "a@example.invalid", authUserId: linked ? "existing" : null }), resolveIdentityForEmail: resolve },
    authority: { linkSubjectAccount: write } });
  expect(result).toEqual({ outcome: "noop" }); expect(resolve).toHaveBeenCalledTimes(linked ? 0 : 1);
  expect(write).toHaveBeenCalledExactlyOnceWith({ subjectId: "subject", expectedEmail: "a@example.invalid", authUserId: linked ? null : "resolved", operatorId: "operator", idempotencyKey: "link-key" });
});
