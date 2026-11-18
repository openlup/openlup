import { createCatalogSubscriptionProfileBinding, type CatalogSubscriptionPolicyBinding } from "../../subscriptions/index.js";
import { z } from "../validation.js";
import { catalogProductTypeRefSchema, catalogQuantitySchema } from "../productTypeSchemas.js";
import type { CatalogPackInput } from "../contracts/index.js";

const policyRefSchema = catalogProductTypeRefSchema.extend({ digest: z.string().regex(/^[a-f0-9]{64}$/u) });
const policySchema = z.discriminatedUnion("kind", [z.strictObject({
  kind: z.literal("units_per_day"),
  ref: policyRefSchema,
  coverage: z.enum(["exact", "allow_shortfall", "allow_surplus"]),
}), z.strictObject({ kind: z.literal("host_policy"), ref: policyRefSchema })]);
const selectionSchema = z.strictObject({
  cadenceDays: z.number().int().positive(),
  lines: z.array(z.strictObject({
    id: z.string().min(1), type: catalogProductTypeRefSchema, quantity: z.number().int().positive(),
    addon: z.boolean().optional(),
    demand: z.strictObject({ contentPerUnit: catalogQuantitySchema, perDay: catalogQuantitySchema }).optional(),
  })).min(1),
});

type HostValidator = Extract<CatalogSubscriptionPolicyBinding, { kind: "host_policy" }>["validate"];

export function catalogConformanceProfileOwners(pack: CatalogPackInput, rawPolicies: readonly unknown[],
  issue: (code: string, path: string, unavailable?: boolean) => void, hostValidators: readonly (HostValidator | undefined)[] = []) {
  const policies: CatalogSubscriptionPolicyBinding[] = [];
  const missingCallbacks = new Set<string>();
  const identities = new Set<string>();
  for (const [index, input] of rawPolicies.entries()) {
    const parsed = policySchema.safeParse(input);
    const path = `/profilePolicies/${index}`;
    if (!parsed.success) { issue("conformance_subject_invalid", path); continue; }
    const policy = parsed.data;
    const validate = hostValidators[index];
    const { ref } = policy;
    const identity = `${ref.key}@${ref.version}`;
    if (identities.has(identity)) { issue("policy_binding_missing", path); continue; }
    identities.add(identity);
    if (policy.kind === "units_per_day") policies.push(policy);
    else if (validate) policies.push({ ...policy, validate });
    else missingCallbacks.add(`${identity}:${ref.digest}`);
  }
  // catalogPackIssues has already admitted the definitions through SP1's common validator.
  const binding = createCatalogSubscriptionProfileBinding({ profiles: pack.subscriptionProfileDefinitions ?? [], policies });
  function needsCallback(profile: NonNullable<ReturnType<typeof binding.resolve>>): boolean {
    const policy = profile.profile.consumption;
    return policy.kind === "host_policy" &&
      missingCallbacks.has(`${policy.policyRef.key}@${policy.policyRef.version}:${policy.policyRef.digest}`);
  }
  return {
    check(rawSelections: readonly unknown[]) {
      for (const [index, ref] of (pack.subscriptionProfiles ?? []).entries()) {
        const profile = binding.resolve(ref);
        if (!profile) issue("profile_missing", `/pack/subscriptionProfiles/${index}`);
        else if (needsCallback(profile)) issue("conformance_owner_unavailable", `/pack/subscriptionProfiles/${index}`, true);
        else if (!profile.bound) issue("policy_binding_missing", `/pack/subscriptionProfiles/${index}`);
      }
      for (const [index, raw] of rawSelections.entries()) {
        const path = `/profileChecks/${index}`;
        const selection = selectionSchema.safeParse(raw);
        if (!selection.success) { issue("conformance_subject_invalid", path); continue; }
        const lineItems = selection.data.lines.map((line, lineIndex) => {
          const definition = pack.types.find(type => type.key === line.type.key && type.version === line.type.version);
          if (!definition) { issue("type_not_installed", `${path}/lines/${lineIndex}/type`); return; }
          const ref = definition.subscriptionProfileRef;
          const profile = ref && binding.resolve(ref);
          if (profile && needsCallback(profile)) return;
          return { id: line.id, typeRef: line.type, quantity: line.quantity, sellable: true, addon: line.addon ?? false,
            ...(ref ? { profileRef: ref } : {}), ...(profile ? { profileDigest: profile.digest } : {}),
            ...(line.demand ? { demand: line.demand } : {}) };
        });
        if (lineItems.some(line => !line)) continue;
        const decision = binding.check({ cadenceDays: selection.data.cadenceDays, lineItems: lineItems.filter(line => line !== undefined) });
        if (decision.kind === "refused") issue(decision.issue.code, path + decision.issue.path.replace(/^\/lineItems/u, "/lines"));
        if (decision.kind === "legacy") issue("profile_missing", path);
      }
    },
    observeRefusal(capability: string) {
      if (capability !== "prepaid") return;
      const definition = pack.types.find(type => type.subscriptionProfileRef);
      if (!definition?.subscriptionProfileRef) return;
      const profile = binding.resolve(definition.subscriptionProfileRef);
      if (!profile?.bound) return;
      const decision = binding.bindAcceptance({
        cadenceDays: profile.profile.allowedCadenceDays[0]!,
        lineItems: [{ id: "offline-line", typeRef: { key: definition.key, version: definition.version }, quantity: 1,
          sellable: true, addon: false, profileRef: definition.subscriptionProfileRef, profileDigest: profile.digest }],
        prepaid: true,
      });
      return { code: decision.kind === "refused" ? decision.issue.code : undefined, zeroEffects: !("acceptance" in decision) };
    },
  };
}
