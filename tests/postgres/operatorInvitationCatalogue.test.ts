import { expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { invitationPredecessor } from "./operatorInvitationCatalogue.js";

const invitation = { file: "db/platform/migrations/20261018120000_identity_operator_invitations.sql", sha256: "1".repeat(64) };
const prefix = [{ file: "db/platform/migrations/20261017120000_example.sql", sha256: "2".repeat(64) }];

it("retains the exact predecessor rows with zero, one or several later forwards", () => {
  for (const count of [0, 1, 3]) {
    const forward = [...prefix, invitation, ...Array.from({ length: count }, (_, index) => ({ file: `db/platform/migrations/2026101912000${index}_example.sql`, sha256: "3".repeat(64) }))];
    const snapshot = structuredClone(forward);
    expect(invitationPredecessor(forward)).toEqual(prefix);
    expect(forward).toEqual(snapshot);
  }
});

it("refuses a missing invitation instead of silently shortening the history", () => {
  expect(() => invitationPredecessor(prefix)).toThrow("invitation forward is missing");
});

it("cuts the installed catalogue before invitations and retains earlier identities", () => {
  const { forward } = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as { forward: { file: string; sha256: string }[] };
  const before = invitationPredecessor(forward);
  expect(forward[before.length].file).toBe(invitation.file);
  expect(before.length).toBeGreaterThan(0);
  expect(before.at(-1)?.file).toBe("db/platform/migrations/20260914130000_customer_diagnostic_prune_job.sql");
  expect(before).not.toContainEqual(expect.objectContaining({ file: invitation.file }));
});
