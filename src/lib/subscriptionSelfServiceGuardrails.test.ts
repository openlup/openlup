import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

describe("subscription self-service guardrails", () => {
  it("keeps durable shipping-address action wired through contract, SQL, UI, smoke, and docs", () => {
    const expected = "change_shipping_address";
    for (const path of [
      "src/domains/subscription/selfServiceContracts.ts",
      "supabase/migrations/20260622150000_subscription_change_shipping_address.sql",
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
      "supabase/migrations/20260622150000_subscription_change_shipping_address.sql",
      "src/pages/account/v2/subscriptions/modals/ChangeShippingAddressModal.tsx",
    ]) {
      expect(read(path), path).not.toMatch(/gift[_-]?next|next[_-]?box/i);
    }
  });
});

function read(path: string) {
  return readFileSync(join(repoRoot, path), "utf8");
}
