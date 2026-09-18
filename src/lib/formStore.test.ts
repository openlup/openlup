import { describe, expect, it } from "vitest";
import {
  defaultFormData,
  getFormData,
  getPetName,
  setFormData,
  type FormData,
} from "@/lib/formStore";

describe("formStore", () => {
  it("starts with the default form data", () => {
    expect(getFormData()).toEqual(defaultFormData);
  });

  it("stores a defensive copy of submitted data", () => {
    const formData: FormData = {
      ...defaultFormData,
      dogName: "Rex",
      email: "rex@example.com",
      gdprConsent: true,
    };

    setFormData(formData);
    formData.dogName = "Changed";

    expect(getFormData()).toEqual({
      ...defaultFormData,
      dogName: "Rex",
      email: "rex@example.com",
      gdprConsent: true,
    });
  });

  it("returns the dog name when present", () => {
    expect(getPetName({ ...defaultFormData, dogName: "Luna" })).toBe("Luna");
  });

  it("falls back to the generic pet label when no dog name is present", () => {
    expect(getPetName(defaultFormData)).toBe("Twojego pupila");
  });
});
