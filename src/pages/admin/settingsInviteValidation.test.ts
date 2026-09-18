import { describe, expect, it } from "vitest";
import { normalizeAdminInviteEmail } from "./settingsInviteValidation";

describe("normalizeAdminInviteEmail", () => {
  it("normalizes valid invite emails and rejects invalid ones", () => {
    expect(normalizeAdminInviteEmail(" NEW@OPENLUP.COM ")).toBe("new@openlup.com");
    expect(() => normalizeAdminInviteEmail("not-email")).toThrow("Niepoprawny email");
  });
});
