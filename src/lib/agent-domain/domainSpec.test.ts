import { describe, expect, it } from "vitest";
import { z } from "../validation/zod.js";

import type {
  AgentDomainQuerySpec,
  AgentDomainSpec,
} from "./domainSpec.js";

/**
 * Type-shape guards for the kit seam: `queries`/`readFlag` are OPTIONAL on
 * `AgentDomainSpec`, so a domain WITHOUT a read surface (e.g. Promotions) still
 * satisfies the interface, while a read-capable domain can add typed queries.
 */
describe("AgentDomainSpec — optional read surface", () => {
  const idSchema = z.string() as unknown as AgentDomainSpec<string, "X", unknown>["idSchema"];
  const baseRules = () => ({ ok: true, violations: [] as "X"[] });

  it("compiles for a domain with NO queries / readFlag (back-compat, e.g. Promotions)", () => {
    const spec: AgentDomainSpec<string, "X", unknown> = {
      domainKey: "promo",
      mutationFlag: "PROMO_MUTATIONS_ENABLED",
      activationFlag: "PROMO_ACTIVATION_ENABLED",
      idSchema,
      ruleCodes: ["X"],
      rules: baseRules,
      auditEntityType: "promo",
      mutations: {},
    };
    expect(spec.queries).toBeUndefined();
    expect(spec.readFlag).toBeUndefined();
  });

  it("compiles for a domain WITH typed read queries + a readFlag", () => {
    const list: AgentDomainQuerySpec = {
      key: "list",
      requestSchema: z.object({ q: z.string().optional() }),
      gate: "read",
      allowedActorKinds: ["human", "machine"],
    };
    const spec: AgentDomainSpec<string, "X", unknown> = {
      domainKey: "thing",
      mutationFlag: "THING_MUTATIONS_ENABLED",
      activationFlag: "THING_ACTIVATION_ENABLED",
      readFlag: "THING_READ_ENABLED",
      idSchema,
      ruleCodes: ["X"],
      rules: baseRules,
      auditEntityType: "thing",
      mutations: {},
      queries: { list },
    };
    expect(spec.readFlag).toBe("THING_READ_ENABLED");
    expect(spec.queries?.list.gate).toBe("read");
  });
});
