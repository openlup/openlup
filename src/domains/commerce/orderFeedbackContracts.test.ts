import { expect, it } from "vitest";
import * as facade from "./orderFeedbackContracts.js";
import * as commerce from "@openlup/platform/commerce";
it("preserves package export identity", () => {
  expect(Object.keys(facade).sort()).toEqual(["ORDER_FEEDBACK_CHECK_RPC_NAME", "ORDER_FEEDBACK_SUBMIT_RPC_NAME", "orderFeedbackSubmitRequestSchema", "orderFeedbackSubmitResponseSchema", "orderFeedbackSubmitStatusSchema", "orderFeedbackTokenCheckRequestSchema", "orderFeedbackTokenCheckResponseSchema", "orderFeedbackTokenCheckStatusSchema"]);
  for (const [name, value] of Object.entries(facade)) expect(value).toBe(commerce[name as keyof typeof commerce]);
});
