import { chmodSync, lstatSync, mkdtempSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createCapturedIdentityMailbox } from "./capturedIdentityMailbox.js";
import type { IdentityReferenceProfile } from "./referenceIdentityPolicy.js";
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function setup() {
  const directory = mkdtempSync(join(tmpdir(), "identity-mailbox-")); directories.push(directory);
  const profile: IdentityReferenceProfile = { directory, origin: "http://127.0.0.1:58421", runId: "11111111-1111-4111-8111-111111111111", bundle: "node-postgres", assertOwned: vi.fn(async () => {}) };
  return profile;
}
const challenge = { email: "reader@example.com", token: "synthetic-opaque-challenge", expiresAt: "2099-01-01T00:00:00.000Z" };
it("direct_mailbox_delivers_both_audiences", async () => {
  const profile = setup();
  const mailbox = await createCapturedIdentityMailbox(profile);
  await mailbox.customer.deliver(challenge); await mailbox.operator.deliver(challenge);
  const customers = await mailbox.read("customer"), operators = await mailbox.read("operator");
  expect(customers).toHaveLength(1); expect(operators).toHaveLength(1);
  expect(customers[0]).toMatchObject({ kind: "customer", challenge });
  expect(customers[0]).not.toHaveProperty("callback");
  expect(operators[0]).toMatchObject({ kind: "operator", challenge, callback: `${profile.origin}/admin/auth/callback#operator_token=${challenge.token}` });
  const folder = join(profile.directory, "mailbox");
  expect(lstatSync(folder).mode & 0o777).toBe(0o700);
  for (const file of readdirSync(folder)) expect(lstatSync(join(folder, file)).mode & 0o777).toBe(0o600);
});
it("captures role notifications through the existing port", async () => {
  const mailbox = await createCapturedIdentityMailbox(setup());
  const notification = { email: "operator@example.com", authUserId: "22222222-2222-4222-8222-222222222222", role: "admin" as const, locale: "en" as const };
  expect(await mailbox.roleNotifications.sendRoleGranted(notification)).toMatchObject({ ok: true, skipped: false });
  expect(await mailbox.read("role")).toEqual([expect.objectContaining({ kind: "role", notification })]);
});
it("lost ownership refuses delivery and retrieval before effects", async () => {
  const profile = setup(), mailbox = await createCapturedIdentityMailbox(profile);
  vi.mocked(profile.assertOwned).mockRejectedValue(new Error("ownership lost"));
  await expect(mailbox.customer.deliver(challenge)).rejects.toThrow("ownership lost");
  await expect(mailbox.read("customer")).rejects.toThrow("ownership lost");
  expect(readdirSync(join(profile.directory, "mailbox"))).toEqual([]);
});
it("refuses a reused directory and unsafe message permissions or links", async () => {
  const profile = setup(), mailbox = await createCapturedIdentityMailbox(profile);
  await expect(createCapturedIdentityMailbox(profile)).rejects.toThrow();
  await mailbox.customer.deliver(challenge);
  const directory = join(profile.directory, "mailbox"), name = readdirSync(directory)[0];
  chmodSync(join(directory, name), 0o644);
  await expect(mailbox.read("customer")).rejects.toThrow("Unsafe identity mailbox message");
  rmSync(join(directory, name)); symlinkSync(join(profile.directory, "identity-owner.json"), join(directory, name));
  await expect(mailbox.read("customer")).rejects.toThrow();
});
