import { describe, expect, it } from "vitest";
import { effectiveFunctionBody } from "../test/effectiveMigration";
import { explicitFunctionExecuteRoles } from "../test/historicalBoundarySchema";

const functions = ["subscription_record_payment_recovery_request", "subscription_resume_from_dunning_with_cycle_order"];
describe("current payment recovery token boundary", () => {
  for (const name of functions) {
    it(`${name} looks up tokens exclusively by SHA-256 and retains server-only execution`, () => {
      const body = effectiveFunctionBody(name);
      expect(body).toMatch(/WHERE (?:token\.)?token_hash = encode\(sha256\(convert_to\(p_recovery_token, 'UTF8'\)\), 'hex'\)/);
      expect(body).not.toContain("token_hash IN (");
      expect(body).not.toContain("md5(p_recovery_token))");
      expect(body).not.toContain(":= md5(v_token)");
      for (const roles of explicitFunctionExecuteRoles(name).values()) {
        expect(roles.has("service_role")).toBe(true);
        for (const role of ["PUBLIC", "anon", "authenticated"]) expect(roles.has(role)).toBe(false);
      }
      expect(body).not.toMatch(/CREATE TABLE|ALTER TABLE|DROP TABLE|\b(?:stripe|tpay|fakturownia)\b/);
    });
  }
});
