import { describe, expect, it } from "vitest";

import { createEmailNotificationControlPort } from "./emailNotificationControl.js";

function makeClient(rows: Record<string, { enabled: boolean } | null>, errorSlugs = new Set<string>()) {
  const seen: string[] = [];
  return {
    seen,
    from(tableName: string) {
      let slug = "";
      return {
        select() {
          return this;
        },
        eq(column: string, value: unknown) {
          if (tableName === "comms_notification_controls" && column === "slug") {
            slug = String(value);
            seen.push(slug);
          }
          return this;
        },
        maybeSingle() {
          if (errorSlugs.has(slug)) return Promise.resolve({ data: null, error: { message: "boom" } });
          return Promise.resolve({ data: rows[slug] ?? null, error: null });
        },
      };
    },
  };
}

describe("createEmailNotificationControlPort", () => {
  it("blocks explicit disabled exact control rows", async () => {
    const client = makeClient({ "commerce-order-confirmation": { enabled: false } });
    const port = createEmailNotificationControlPort(client);

    await expect(port.isEnabled("commerce-order-confirmation", new AbortController().signal)).resolves.toBe(false);
  });

  it("blocks disabled family controls after checking the exact slug", async () => {
    const client = makeClient({ "subscription-payment-failed-*": { enabled: false } });
    const port = createEmailNotificationControlPort(client);

    await expect(port.isEnabled("subscription-payment-failed-3", new AbortController().signal)).resolves.toBe(false);
    expect(client.seen).toEqual(["subscription-payment-failed-3", "subscription-payment-failed-*"]);
  });

  it("fails open for missing rows and lookup errors", async () => {
    const missing = createEmailNotificationControlPort(makeClient({}));
    await expect(missing.isEnabled("commerce-order-confirmation", new AbortController().signal)).resolves.toBe(true);

    const errored = createEmailNotificationControlPort(
      makeClient({}, new Set(["commerce-order-confirmation"])),
    );
    await expect(errored.isEnabled("commerce-order-confirmation", new AbortController().signal)).resolves.toBe(true);
  });
});
