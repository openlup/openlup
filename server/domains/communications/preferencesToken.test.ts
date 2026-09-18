import { describe, expect, it } from "vitest";
import {
  createCommunicationPreferenceToken,
  verifyCommunicationPreferenceToken,
} from "./preferencesToken.js";

describe("communication preference token", () => {
  it("round-trips purpose-scoped self-service tokens", () => {
    const token = createCommunicationPreferenceToken({
      email: "ala@example.com",
      purpose: "marketing_newsletter",
      expiresAt: 2_000,
    }, "secret");

    expect(verifyCommunicationPreferenceToken(token, "secret", 1_000)).toEqual({
      email: "ala@example.com",
      purpose: "marketing_newsletter",
      expiresAt: 2_000,
    });
  });

  it("rejects tampered or expired tokens", () => {
    const token = createCommunicationPreferenceToken({
      email: "ala@example.com",
      purpose: "marketing_newsletter",
      expiresAt: 2_000,
    }, "secret");

    expect(verifyCommunicationPreferenceToken(`${token}x`, "secret", 1_000)).toBeNull();
    expect(verifyCommunicationPreferenceToken(token, "secret", 3_000)).toBeNull();
  });
});
