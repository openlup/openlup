import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { effectiveFunctionBody } from "../test/effectiveMigration.js";
const repoRoot = process.cwd();
const SHIPPING_ACTION_CHAIN = [
  "customer_self_service_apply_subscription_action",
  "customer_self_service_apply_action_before_anchor_fence",
  "customer_self_service_apply_action_before_resume_terminalizes",
  "customer_self_service_apply_action_before_expired_resume",
  "customer_self_service_apply_action_before_moq",
  "customer_self_service_apply_action_before_dunning_cancel",
  "customer_self_service_apply_subscription_action_pre_cadence",
  "customer_self_service_apply_subscription_action_legacy_wave5",
  "customer_self_service_apply_action_before_address_ownership",
] as const;

function shippingActionChain(): string {
  const bodies = SHIPPING_ACTION_CHAIN.map(effectiveFunctionBody);
  for (let index = 0; index < bodies.length - 1; index++) {
    // Assert the actual call with the same action/payload, excluding comments.
    const source = bodies[index]!.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, "");
    const delegate = SHIPPING_ACTION_CHAIN[index + 1]!;
    expect(source, `${SHIPPING_ACTION_CHAIN[index]} delegates to ${delegate}`).toMatch(new RegExp(
      `public\\.${delegate}\\(\\s*p_auth_user_id,\\s*p_idempotency_key,\\s*p_subscription_id,\\s*p_action,\\s*p_payload,\\s*p_requested_at\\s*\\)`,
    ));
  }
  const mutation = bodies[bodies.length - 1]!;
  expect(mutation).toContain("IF p_action = 'change_shipping_address' THEN");
  expect(mutation).toContain("SET shipping_address_id = v_shipping_address_id");
  return bodies.join("\n");
}

describe("subscription self-service guardrails", () => {
  it("keeps shipped shipping-address action wired through contract, SQL and UI", () => {
    for (const path of [
      "src/domains/subscription/selfServiceContracts.ts",
      "shipped:subscription_change_shipping_address",
      "src/pages/account/v2/subscriptions/modals/ChangeShippingAddressModal.tsx",
    ]) expect(read(path), path).toContain("change_shipping_address");
  });

  it("keeps durable shipping-address action wired through contract, SQL, UI, smoke, and docs", () => {
    const expected = "change_shipping_address";
    for (const path of [
      "src/domains/subscription/selfServiceContracts.ts",
      "shipped:subscription_change_shipping_address",
      "src/pages/account/v2/subscriptions/modals/ChangeShippingAddressModal.tsx",
      "scripts/smoke-customer-subscription-preview-assertions.ts",
      "docs/BFF_CONTRACTS.md",
      "docs/BACKEND.md",
    ]) {
      expect(read(path), path).toContain(expected);
    }
  });

  it("keeps gift-next-box out of subscription self-service runtime surfaces", () => {
    for (const path of [
      "src/domains/subscription/selfServiceContracts.ts",
      "shipped:subscription_change_shipping_address",
      "src/pages/account/v2/subscriptions/modals/ChangeShippingAddressModal.tsx",
    ]) {
      expect(read(path), path).not.toMatch(/gift[_-]?next|next[_-]?box/i);
    }
  });
});

function read(path: string) {
  if (path === "shipped:subscription_change_shipping_address") return shippingActionChain();
  return readFileSync(join(repoRoot, path), "utf8");
}
