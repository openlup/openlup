import { expect, it } from "vitest";
import { resolveCommunicationPreferenceBinding } from "./preferenceBinding.js";
it("selects native persistence without managed fallback and refuses incomplete selection", () => {
  expect(() => resolveCommunicationPreferenceBinding({ PLATFORM_BUNDLE:"node-postgres", SUPABASE_URL:"https://managed.invalid", SUPABASE_SERVICE_ROLE_KEY:"synthetic" })).toThrow();
  expect(() => resolveCommunicationPreferenceBinding({ PLATFORM_BUNDLE:"node-postgres", DATABASE_URL:"injected" })).toThrow("binding_required");
});
