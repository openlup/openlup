import { expect, it } from "vitest";
import { deriveOidcPrincipalId } from "../../src/identity/oidcPrincipal.js";
it("principal_separates_issuer_subject_pairs_with_frozen_golden_vectors", () => {
  expect(deriveOidcPrincipalId("https://issuer.example.com/realm", "subject")).toBe("262d8593-5c2f-8ce3-a5f2-de2751bbfe90");
  expect(deriveOidcPrincipalId("https://issuer.example.com/realm", "subject-2")).toBe("29b16530-0f7c-8431-8d07-fced6f634c74");
  expect(deriveOidcPrincipalId("https://other.example.com/realm", "subject")).toBe("dfbcedd6-df05-8163-a494-d051981be5c9");
  expect(deriveOidcPrincipalId("ab", "c")).not.toBe(deriveOidcPrincipalId("a", "bc"));
  expect(deriveOidcPrincipalId("https://issuer.example.com/realm/", "subject")).not.toBe(deriveOidcPrincipalId("https://issuer.example.com/realm", "subject"));
});
