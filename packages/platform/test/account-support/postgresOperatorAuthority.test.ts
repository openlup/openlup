import { expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import { createPostgresOperatorAuthority, type OperatorQueryExecutor } from "../../src/account-support/postgresOperatorAuthority.js";
const options = { operatorId: "operator", now: () => 0, recoveryPath: (token: string) => `/repair?token=${token}`, createOpaqueToken: () => "private-token" };
const input = { operatorId: "operator", subscriptionId: "subscription", subscriptionAction: "pause", payload: { pausePreset: "indefinite" }, expectedVersion: 4, idempotencyKey: "support-key" } as const;
function port(query: OperatorQueryExecutor["query"]) { return createPostgresOperatorAuthority({ run: work => work({ query }) }, options); }
it("keeps managed positional order and actual nested M10 receipt on success and replay", async () => {
  const ownerReceipt = { id: "owner-receipt", actorId: "operator", idempotencyKey: "m12-support:hash", commandFingerprint: "fingerprint", result: { status: "applied", templateVersion: 5 } };
  const result = { outcome: "applied", subscriptionStatus: "paused", nextCycleAt: null, templateVersion: 5, eventId: "event", appliedBy: null, ownerReceipt };
  const query = vi.fn(async () => ({ rows: [{ result }] }));
  const actual = await port(query).applySubscriptionAction(input);
  expect(actual).toEqual(result);
  expect(query).toHaveBeenCalledExactlyOnceWith("SELECT public.customer_support_apply_subscription_action_v1($1,$2,$3,$4,$5,$6,$7) AS result", ["operator", "subscription", "pause", input.payload, 4, "support-key", "1970-01-01T00:00:00.000Z"]);
});
it.each(["email", "phone", "link", "address"] as const)("native %s refuses without opening the executor", async action => {
  const query = vi.fn(); const authority = port(query);
  const actual = action === "email" ? await authority.correctSubjectEmail({ operatorId: "operator", subjectId: "subject", expectedEmail: "old", newEmail: "new", idempotencyKey: "email-key" })
    : action === "phone" ? await authority.correctSubjectPhone({ operatorId: "operator", subjectId: "subject", expectedPhone: "old", newPhone: "new", idempotencyKey: "phone-key" })
    : action === "link" ? await authority.linkSubjectAccount({ operatorId: "operator", subjectId: "subject", expectedEmail: "old", authUserId: null, idempotencyKey: "link-key" })
    : await authority.applySubscriptionAction({ ...input, subscriptionAction: "change_shipping_address" });
  expect(actual).toEqual({ outcome: "refused", refusalCode: "operator_subscription_authority_unavailable" }); expect(query).not.toHaveBeenCalled();
});
it.each([
  ["22023", "", "customer_support_operator_command_invalid"],
  ["23505", "", "customer_support_idempotency_conflict"],
  ["42501", "customer_support_command_requires_human", "customer_support_command_requires_human"],
  ["42501", "", "managed_customer_support_operator_inactive"],
  ["23503", "", "customer_support_subscription_command_failed"],
  ["42883", "", "operator_subscription_authority_unavailable"],
  ["55000", "", "customer_support_subscription_command_failed"],
] as const)("maps %s / %s through the named failure boundary", async (code, message, expected) => {
  await expect(port(async () => { throw { code, message }; }).applySubscriptionAction(input)).rejects.toMatchObject({ message: expected });
});

it("native recovery awaits Web Crypto hashes for the injected token before querying", async () => {
  const result = { outcome: "issued", deliveryStatus: "queued", auditEventId: "audit" };
  const query = vi.fn(async () => ({ rows: [{ result }] }));
  expect(await port(query).issueRecovery({ operatorId: "operator", subjectId: "subject", caseId: "case", idempotencyKey: "recovery-key" })).toEqual(result);
  expect(query).toHaveBeenCalledExactlyOnceWith("SELECT public.customer_support_issue_recovery($1,$2,$3,$4,$5,$6,$7,$8) AS result", [
    "operator", "subject", "case", "recovery-key",
    createHash("sha256").update(JSON.stringify({ action: "issue_recovery", subjectId: "subject", caseId: "case" })).digest("hex"),
    createHash("sha256").update("private-token").digest("hex"), "1970-01-02T00:00:00.000Z", "/repair?token=private-token",
  ]);
});
