import { describe, expect, it } from "vitest";
import {
  AccountingControlConflictError,
  AccountingControlPersistenceError,
} from "./ports";

describe("accounting ports", () => {
  it("carries conflict details for BFF translation", () => {
    const error = new AccountingControlConflictError("Accounting policy mismatch", {
      code: "23505",
    });

    expect(error.name).toBe("AccountingControlConflictError");
    expect(error.message).toBe("Accounting policy mismatch");
    expect(error.details).toEqual({ code: "23505" });
  });

  it("carries persistence failure details", () => {
    const error = new AccountingControlPersistenceError(undefined, {
      code: "PGRST",
      message: "upstream failed",
    });

    expect(error.name).toBe("AccountingControlPersistenceError");
    expect(error.message).toBe("Accounting control persistence failed");
    expect(error.details).toEqual({ code: "PGRST", message: "upstream failed" });
  });
});
