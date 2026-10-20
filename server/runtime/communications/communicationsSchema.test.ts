import { expect, it } from "vitest";
import { communicationsRequiredSchema } from "./communicationsSchema.js";
it("declares the selected consent, rail, receipt and all native evidence requirements without a physical schema", () => {
  const direct = communicationsRequiredSchema("node-postgres", "full-prefix-70");
  expect(direct.version).toBe("full-prefix-70");
  for (const name of ["communication_recipient_consents", "outbox_events", "transactional_delivery_receipts", "communication_native_sends", "communication_native_observations", "communication_native_sync_state", "notification_recipients", "communication_native_policy_decisions"]) expect(direct.objects.some(object => object.name === `public.${name}`)).toBe(true);
  expect(communicationsRequiredSchema("node-supabase", "selected").objects.some(object => object.name === "public.communication_apply_unsubscribe")).toBe(true);
  expect(() => communicationsRequiredSchema("node-postgres", "")).toThrow();
});
