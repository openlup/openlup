import { describe, expect, it } from "vitest";
import { createSupabasePublicPreferenceTokenPort } from "./publicPreferenceToken.js";

describe("createSupabasePublicPreferenceTokenPort", () => {
  it("exposes public token preference updater", () => {
    expect(createSupabasePublicPreferenceTokenPort({} as never).updatePreference).toBeTypeOf("function");
  });
});
