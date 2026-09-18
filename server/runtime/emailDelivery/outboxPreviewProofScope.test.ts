import { describe, expect, it } from "vitest";
import { readPreviewMatrixProofScope } from "./outboxPreviewProofScope.js";

function reqWithHeader(value?: string | string[]) {
  return {
    headers: value === undefined ? {} : { "x-outbox-preview-matrix-run-id": value },
  } as never;
}

describe("readPreviewMatrixProofScope", () => {
  it("returns no proof scope when the header is absent", () => {
    expect(readPreviewMatrixProofScope(reqWithHeader(), {})).toEqual({ ok: true, runId: null });
  });

  it("rejects proof scope outside hidden preview", () => {
    expect(readPreviewMatrixProofScope(reqWithHeader("matrix-run-1"), {})).toEqual({
      ok: false,
      status: 403,
      body: { ok: false, error: "proof_scope_forbidden" },
    });
  });

  it("rejects malformed proof run ids", () => {
    expect(readPreviewMatrixProofScope(reqWithHeader("../bad"), {
      HIDDEN_SANDBOX_PREVIEW_ENABLED: "true",
    })).toEqual({
      ok: false,
      status: 400,
      body: { ok: false, error: "invalid_proof_run_id" },
    });
  });

  it("accepts a validated proof run id in hidden preview", () => {
    expect(readPreviewMatrixProofScope(reqWithHeader(["matrix-run_1:abc.2"]), {
      HIDDEN_SANDBOX_PREVIEW_ENABLED: "true",
    })).toEqual({ ok: true, runId: "matrix-run_1:abc.2" });
  });
});
