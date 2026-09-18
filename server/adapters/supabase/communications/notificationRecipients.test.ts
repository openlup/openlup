import { describe, expect, it } from "vitest";
import { createSupabaseNotificationRecipientsPort } from "./notificationRecipients.js";

describe("createSupabaseNotificationRecipientsPort", () => {
  it("exposes notification recipient CRUD methods", () => {
    const port = createSupabaseNotificationRecipientsPort({} as never);

    expect(port.listNotificationRecipients).toBeTypeOf("function");
    expect(port.createNotificationRecipient).toBeTypeOf("function");
    expect(port.updateNotificationRecipient).toBeTypeOf("function");
    expect(port.deleteNotificationRecipient).toBeTypeOf("function");
  });
});
