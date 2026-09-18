import { describe, expect, it, vi } from "vitest";

import {
  TpayTransactionDispatchError,
  tpayTransactionDispatchBoundary,
  tpayTrustedPreDispatchFailure,
  tpayTrustedRefusalFailure,
} from "./tpayDispatchFailure.js";
import { TpayHttpError } from "./tpayHttpFailure.js";

describe("Tpay transaction dispatch boundary", () => {
  it("proves OAuth failure before dispatch and never calls the transaction POST", async () => {
    const dispatch = vi.fn();

    await expect(tpayTransactionDispatchBoundary({
      authenticate: vi.fn().mockRejectedValue({ code: "tpay_oauth_timeout" }),
      prepare: vi.fn(),
      dispatch,
      decode: vi.fn(),
    })).rejects.toMatchObject({
      phase: "oauth",
      code: "tpay_oauth_timeout",
      dispatchState: "not_dispatched",
    });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("keeps every transaction transport failure unknown after dispatch begins", async () => {
    await expect(tpayTransactionDispatchBoundary({
      authenticate: vi.fn().mockResolvedValue("token"),
      prepare: vi.fn().mockReturnValue({ amount: 1 }),
      dispatch: vi.fn().mockRejectedValue(new TypeError("socket closed")),
      decode: vi.fn(),
    })).rejects.toMatchObject({
      phase: "transaction_dispatch",
      code: "tpay_transport_failed",
      dispatchState: "unknown",
    });
  });

  it("preserves a sanitized non-2xx diagnostic without changing unknown dispatch state", async () => {
    const failureDiagnostic = {
      httpStatus: 400,
      requestId: "d3a9826d92c48cb8c185",
      providerErrorCodes: ["invalid_request_body"],
      fieldNames: ["payer.email"],
    };
    await expect(tpayTransactionDispatchBoundary({
      authenticate: vi.fn().mockResolvedValue("token"),
      prepare: vi.fn().mockReturnValue({ amount: 1 }),
      dispatch: vi.fn().mockResolvedValue({ ok: false }),
      decode: vi.fn().mockRejectedValue(new TpayHttpError("tpay_request_failed", 400, failureDiagnostic)),
    })).rejects.toMatchObject({
      phase: "response_decode",
      code: "tpay_request_failed",
      dispatchState: "unknown",
      failureDiagnostic,
    });
  });

  it("classifies a proven request refusal as refused rather than unknown", async () => {
    const failureDiagnostic = {
      httpStatus: 400,
      requestId: "d3a9826d92c48cb8c185",
      providerErrorCodes: ["not_valid"],
      fieldNames: ["payer.name"],
    };
    await expect(tpayTransactionDispatchBoundary({
      authenticate: vi.fn().mockResolvedValue("token"),
      prepare: vi.fn().mockReturnValue({ amount: 1 }),
      dispatch: vi.fn().mockResolvedValue({ ok: false }),
      decode: vi.fn().mockRejectedValue(
        new TpayHttpError("tpay_request_failed", 400, failureDiagnostic, true),
      ),
    })).rejects.toMatchObject({
      phase: "response_decode",
      code: "tpay_request_refused",
      dispatchState: "refused",
      failureDiagnostic,
    });
  });

  it("keeps a decode failure the client could not prove refused as unknown", async () => {
    // Same status, same shape, verdict absent: the boundary must not re-derive
    // the refusal, because at this point the raw body is already gone.
    await expect(tpayTransactionDispatchBoundary({
      authenticate: vi.fn().mockResolvedValue("token"),
      prepare: vi.fn().mockReturnValue({ amount: 1 }),
      dispatch: vi.fn().mockResolvedValue({ ok: true }),
      decode: vi.fn().mockRejectedValue(new TpayHttpError("tpay_invalid_response", 200)),
    })).rejects.toMatchObject({
      phase: "response_decode",
      code: "tpay_invalid_response",
      dispatchState: "unknown",
    });
  });

  it("keeps the two trusted vocabularies disjoint", () => {
    const refused = new TpayTransactionDispatchError({
      phase: "response_decode",
      code: "tpay_request_refused",
      dispatchState: "refused",
    });
    const notDispatched = new TpayTransactionDispatchError({
      phase: "transaction_dispatch",
      code: "tpay_request_deadline_exhausted",
      dispatchState: "not_dispatched",
    });

    expect(tpayTrustedRefusalFailure(refused)).toEqual({
      phase: "response_decode",
      code: "tpay_request_refused",
      dispatchState: "refused",
    });
    // Neither reader may accept the other's evidence: that is what stops the
    // weaker proof from satisfying the mode that asserts the stronger one.
    expect(tpayTrustedPreDispatchFailure(refused)).toBeNull();
    expect(tpayTrustedRefusalFailure(notDispatched)).toBeNull();
    expect(tpayTrustedRefusalFailure(new TpayTransactionDispatchError({
      phase: "response_decode",
      code: "tpay_invalid_response",
      dispatchState: "unknown",
    }))).toBeNull();
  });

  it("exposes trusted evidence only for the closed pre-dispatch vocabulary", () => {
    const trusted = new TpayTransactionDispatchError({
      phase: "transaction_dispatch",
      code: "tpay_request_deadline_exhausted",
      dispatchState: "not_dispatched",
    });
    const unknown = new TpayTransactionDispatchError({
      phase: "transaction_dispatch",
      code: "tpay_request_timeout",
      dispatchState: "unknown",
    });

    expect(tpayTrustedPreDispatchFailure(trusted)).toEqual({
      phase: "transaction_dispatch",
      code: "tpay_request_deadline_exhausted",
      dispatchState: "not_dispatched",
    });
    expect(tpayTrustedPreDispatchFailure(unknown)).toBeNull();
  });
});
