import { describe, expect, it } from "vitest";
import { validateProducerContact } from "./producerContactValidation";

describe("validateProducerContact", () => {
  it("normalizes valid producer contact details", () => {
    expect(validateProducerContact({
      name: "  Jane Buyer ",
      company: " Future Foods ",
      email: " JANE@FUTURE.TEST ",
      consent: true,
    })).toEqual({
      success: true,
      value: {
        name: "Jane Buyer",
        company: "Future Foods",
        email: "jane@future.test",
      },
    });
  });

  it("rejects invalid contact details or missing consent", () => {
    expect(validateProducerContact({
      name: "J",
      company: "Future Foods",
      email: "jane@future.test",
      consent: true,
    })).toEqual({ success: false });
    expect(validateProducerContact({
      name: "Jane Buyer",
      company: "Future Foods",
      email: "not-email",
      consent: true,
    })).toEqual({ success: false });
    expect(validateProducerContact({
      name: "Jane Buyer",
      company: "Future Foods",
      email: "jane@future.test",
      consent: false,
    })).toEqual({ success: false });
  });
});
