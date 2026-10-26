import type {
  OperatorEmailCorrectionResult, OperatorEmailCorrectionAdmission, OperatorEmailCorrectionExecution,
  OperatorEmailCorrectionPhase, OperatorEmailCorrectionClaim, OperatorEmailCorrectionSettlement, OperatorIdentityMovePort,
  OperatorAccountLinkIdentityPort, OperatorAccountLinkRequest, OperatorAccountLinkResult,
  ManagedOperatorAuthorityPort, NativeOperatorAuthorityPort, OperatorRecoveryCommandEnvelope,
  OperatorRecoveryCommand, OperatorSubscriptionInput, LinkThenSubscriptionResult,
} from "./contracts/index.js";

export class OperatorIdentityMoveRefusedError extends Error {
  constructor() { super("customer_support_email_correction_identity_refused"); }
}
const normalize = (value: string) => value.trim().toLowerCase();
function terminal(result: OperatorEmailCorrectionSettlement): result is OperatorEmailCorrectionResult {
  return result.outcome !== "pending" && result.outcome !== "failed";
}

/** Recovery is service authority over the recorded command, independent of admission's actor. */
export async function moveIdentityForEmailCorrection(input: {
  admission: OperatorEmailCorrectionAdmission;
  claim: () => Promise<OperatorEmailCorrectionExecution>;
  identity: () => OperatorIdentityMovePort;
  settle: (phase: OperatorEmailCorrectionPhase, claim: OperatorEmailCorrectionClaim) => Promise<OperatorEmailCorrectionSettlement>;
}): Promise<OperatorEmailCorrectionResult> {
  if (input.admission.outcome !== "admitted") return input.admission;
  const execution = await input.claim();
  if (execution.outcome === "failed") throw new Error("customer_support_email_correction_failed");
  if (execution.outcome === "pending") throw new Error("customer_support_email_correction_in_progress");
  if (execution.outcome !== "claimed") return execution;
  try {
    if (execution.authUserId) {
      const identity = input.identity();
      const current = normalize(await identity.readIdentityEmail(execution.authUserId));
      if (current !== normalize(execution.newEmail)) {
        if (current !== normalize(execution.originalEmail)) throw new Error("identity_changed");
        await identity.moveIdentityEmail(execution.authUserId, execution.newEmail, {
          idempotencyKey: execution.idempotencyKey, claimToken: execution.claimToken, sequence: execution.sequence,
        });
        if (normalize(await identity.readIdentityEmail(execution.authUserId)) !== normalize(execution.newEmail)) {
          throw new Error("identity_unconfirmed");
        }
      }
    }
    const result = await input.settle("complete", execution);
    if (terminal(result)) return result;
    if (result.outcome === "failed") throw new Error("customer_support_email_correction_failed");
    throw new Error("completion_unsettled");
  } catch (error) {
    if (error instanceof Error && error.message === "customer_support_email_correction_failed") throw error;
    try {
      // SQL locks Auth before the receipt and checks the actual identity. Failure
      // cannot release an applied effect; release fences any delayed provider PUT.
      const result = await input.settle(error instanceof OperatorIdentityMoveRefusedError ? "fail" : "release", execution);
      if (terminal(result)) return result;
      if (result.outcome === "failed") throw new Error("customer_support_email_correction_failed");
    } catch (settlementError) {
      if (settlementError instanceof Error && settlementError.message === "customer_support_email_correction_failed") throw settlementError;
      // The durable claim expires if storage is unavailable; its old writes are fenced.
    }
    throw new Error("customer_support_email_correction_repair_required");
  }
}

/** Donor link resolution uses only the subject's confirmed stored email. */
export async function executeOperatorAccountLink(input: {
  command: OperatorAccountLinkRequest; operatorId: string;
  identity: OperatorAccountLinkIdentityPort; authority: Pick<ManagedOperatorAuthorityPort, "linkSubjectAccount">;
}): Promise<OperatorAccountLinkResult> {
  const { command } = input;
  const subject = await input.identity.findSubject(command.subjectId);
  const expected = normalize(command.expectedEmail);
  const linkable = subject !== null && subject.identityKind === "customer" && !subject.authUserId
    && expected !== "" && normalize(subject.email ?? "") === expected;
  const authUserId = linkable ? await input.identity.resolveIdentityForEmail(expected) : null;
  return input.authority.linkSubjectAccount({ subjectId: command.subjectId, expectedEmail: expected,
    authUserId, idempotencyKey: command.idempotencyKey, operatorId: input.operatorId });
}

/** Two commands, two commits. Callback invocation keeps the donor's non-await order. */
export async function linkThenApply(input: {
  link: () => Promise<OperatorAccountLinkResult>;
  apply: () => ReturnType<NativeOperatorAuthorityPort["applySubscriptionAction"]>;
  onLinked: () => unknown;
}): Promise<LinkThenSubscriptionResult> {
  const { link, apply, onLinked } = input;
  const linked = await link();
  if (linked.outcome === "refused" || linked.outcome === "conflict") return { outcome: "link_refused", link: linked };
  void onLinked();
  try {
    const subscription = await apply();
    return { outcome: "refusalCode" in subscription ? "partial" : "completed", link: linked, subscription };
  } catch {
    return { outcome: "partial", link: linked, subscription: null };
  }
}

export type OperatorRecoverySelection =
  | { graph: "managed"; authority: ManagedOperatorAuthorityPort; identity: () => OperatorIdentityMovePort; accountLink: OperatorAccountLinkIdentityPort }
  | { graph: "native"; authority: NativeOperatorAuthorityPort };

/** Host verifies the operator seat before construction; every dispatch keeps its actor binding. */
export function createOperatorRecovery(selection: OperatorRecoverySelection) {
  return {
    async execute(envelope: OperatorRecoveryCommandEnvelope<OperatorRecoveryCommand | OperatorAccountLinkRequest>) {
      const { actor, command } = envelope;
      if (actor.role !== "admin" || actor.isMachineActor !== false) throw new Error("customer_support_command_requires_human");
      if (actor.graph !== selection.graph || !actor.operatorId.trim()) throw new Error("customer_support_operator_scope_mismatch");
      if (envelope.idempotencyKey !== command.idempotencyKey) throw new Error("customer_support_idempotency_conflict");
      if ("subjectId" in command && envelope.subject.subjectId !== command.subjectId) throw new Error("customer_support_operator_command_invalid");
      const operatorId = actor.operatorId;
      switch (command.action) {
        case "apply_subscription_action": {
          if (envelope.subject.subscriptionId !== command.subscriptionId || envelope.expectedVersion !== command.expectedVersion) {
            throw new Error("customer_support_operator_command_invalid");
          }
          const input: OperatorSubscriptionInput = { subscriptionId: command.subscriptionId, subscriptionAction: command.subscriptionAction,
            expectedVersion: command.expectedVersion, idempotencyKey: command.idempotencyKey, operatorId, payload: command.payload ?? {} };
          return selection.authority.applySubscriptionAction(input);
        }
        case "correct_email": {
          const input = { subjectId: command.subjectId, expectedEmail: command.expectedEmail, newEmail: command.newEmail, idempotencyKey: command.idempotencyKey, operatorId };
          if (selection.graph === "native") return selection.authority.correctSubjectEmail(input);
          const admission = await selection.authority.correctSubjectEmail(input);
          return moveIdentityForEmailCorrection({ admission, identity: selection.identity,
            claim: () => selection.authority.claimSubjectEmail({ idempotencyKey: command.idempotencyKey }),
            settle: (phase, claim) => selection.authority.settleSubjectEmail({ idempotencyKey: claim.idempotencyKey, claimToken: claim.claimToken, phase }) });
        }
        case "correct_phone": return selection.authority.correctSubjectPhone({ subjectId: command.subjectId, expectedPhone: command.expectedPhone, newPhone: command.newPhone, idempotencyKey: command.idempotencyKey, operatorId });
        case "issue_recovery": return selection.authority.issueRecovery({ subjectId: command.subjectId, caseId: command.caseId, idempotencyKey: command.idempotencyKey, operatorId });
        case "absorb_lead": return selection.authority.absorbLead({ customerId: command.subjectId, leadId: command.leadId, expectedLeadEmail: command.expectedLeadEmail, idempotencyKey: command.idempotencyKey, operatorId });
        case "link_account":
          if (selection.graph === "native") return selection.authority.linkSubjectAccount({ subjectId: command.subjectId, expectedEmail: command.expectedEmail, idempotencyKey: command.idempotencyKey, authUserId: null, operatorId });
          return executeOperatorAccountLink({ command, operatorId, identity: selection.accountLink, authority: selection.authority });
      }
    },
  };
}
