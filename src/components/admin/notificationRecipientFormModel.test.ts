import { describe, expect, it } from "vitest";
import { parseNotificationRecipientInput } from "./notificationRecipientFormModel";

describe("parseNotificationRecipientInput", () => {
  it("normalizes valid recipient input for the existing payload shape", () => {
    expect(parseNotificationRecipientInput({
      email: " Warehouse@Example.COM ",
      name: "  Warehouse Team  ",
    })).toEqual({
      email: "warehouse@example.com",
      name: "Warehouse Team",
    });
  });

  it("keeps optional names as null and rejects invalid changed values", () => {
    expect(parseNotificationRecipientInput({
      email: "ops@example.com",
      name: "",
    })).toEqual({
      email: "ops@example.com",
      name: null,
    });

    expect(() => parseNotificationRecipientInput({
      email: "not-email",
      name: "Ops",
    })).toThrow("Niepoprawny email");
    expect(() => parseNotificationRecipientInput({
      email: "ops@example.com",
      name: "x",
    })).toThrow("Niepoprawne imię");
  });
});
