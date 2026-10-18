import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createCapturedCustomerChallengeDelivery, type CapturedCustomerChallenge, type AdminRoleNotificationPort } from "@openlup/platform/identity";
import type { IdentityReferenceProfile } from "./referenceIdentityPolicy.js";

type Message = { id: string; kind: "customer" | "operator"; challenge: CapturedCustomerChallenge; callback?: string }
  | { id: string; kind: "role"; notification: Parameters<AdminRoleNotificationPort["sendRoleGranted"]>[0] };

/** Local files are credentials: never include messages in ordinary diagnostics or test reports. */
export async function createCapturedIdentityMailbox(profile: IdentityReferenceProfile) {
  await profile.assertOwned();
  const directory = join(profile.directory, "mailbox");
  mkdirSync(directory, { mode: 0o700 });
  function checkDirectory() {
    const info = lstatSync(directory);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700) throw new Error("Identity mailbox must be private");
  }
  async function write(message: Message) {
    await profile.assertOwned(); checkDirectory();
    const descriptor = openSync(join(directory, `${message.id}.json`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(descriptor, JSON.stringify(message)); } finally { closeSync(descriptor); }
  }
  const delivery = (kind: "customer" | "operator") => createCapturedCustomerChallengeDelivery(async challenge => {
    const callback = new URL("/admin/auth/callback", profile.origin);
    callback.hash = new URLSearchParams({ operator_token: challenge.token }).toString();
    await write({ id: randomUUID(), kind, challenge, ...(kind === "operator" ? { callback: callback.href } : {}) });
  });
  const roleNotifications: AdminRoleNotificationPort = { async sendRoleGranted(notification) {
    const id = randomUUID();
    await write({ id, kind: "role", notification });
    return { ok: true, providerMessageId: id, providerError: null, skipped: false, skipReason: null };
  } };
  return { customer: delivery("customer"), operator: delivery("operator"), roleNotifications,
    async read(kind: Message["kind"]): Promise<readonly Message[]> {
      await profile.assertOwned(); checkDirectory();
      const messages: Message[] = [];
      for (const name of readdirSync(directory).sort()) {
        if (!/^[a-f0-9-]{36}\.json$/.test(name)) throw new Error("Unexpected identity mailbox entry");
        const fd = openSync(join(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const info = fstatSync(fd);
          if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > 32768) throw new Error("Unsafe identity mailbox message");
          const message = JSON.parse(readFileSync(fd, "utf8")) as Message;
          if (`${message.id}.json` !== name || !["customer", "operator", "role"].includes(message.kind)) throw new Error("Invalid identity mailbox message");
          if (message.kind === kind) messages.push(message);
        } finally { closeSync(fd); }
      }
      return messages;
    },
  };
}
