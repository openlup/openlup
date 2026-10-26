import { render, screen, cleanup } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { AccountSupportRecoveryStatus } from "./accountSupportRecovery.js";
import { operatorAuthorityCapabilities } from "@openlup/platform/account-support";
afterEach(cleanup);
it("shows the completed link and separate refused subscription action truthfully", () => {
  render(<AccountSupportRecoveryStatus capabilities={operatorAuthorityCapabilities("managed")} action="pause"
    result={{ outcome: "partial", link: { outcome: "applied" }, subscription: { outcome: "refused", refusalCode: "payment_blocked" } }} />);
  expect(screen.getByRole("status").textContent).toContain("Account linked. Subscription action incomplete.");
  expect(screen.getByRole("status").textContent).toContain("payment_blocked");
});
it("shows an unsupported native action's named refusal", () => {
  render(<AccountSupportRecoveryStatus capabilities={operatorAuthorityCapabilities("native")} action="link" />);
  expect(screen.getByRole("status").textContent).toBe("operator_subscription_authority_unavailable");
});
