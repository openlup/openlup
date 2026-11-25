import { createHash } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS } from "@/domains/commerce/paymentContinuationContracts";

import { CHECKOUT_ATTEMPT_STORAGE_KEY } from "./checkoutAttemptStore";
import {
  CHECKOUT_CONTINUATION_KEY,
  LEGACY_CHECKOUT_CONTINUATION_KEY,
  clearCheckoutContinuation,
  persistCheckoutContinuation,
  readCheckoutContinuation,
  setCheckoutContinuationPhase,
} from "./checkoutNavigation";

/**
 * Characterization of the continuation marker: what is written, every shape the
 * reader accepts, and what the four functions do to storage. The wait-exhaustion
 * stamp and the account-order-return stash are pinned in their own files.
 */

const NOW_MS = Date.parse("2030-01-01T00:00:00.000Z");
const NOW_SECONDS = NOW_MS / 1000;

const MARKER = {
  orderId: "11111111-1111-4111-8111-111111111111",
  orderRef: "order_ref",
  paymentIntentId: "22222222-2222-4222-8222-222222222222",
  clientId: "33333333-3333-4333-8333-333333333333",
  journeyId: "checkout:44444444-4444-4444-8444-444444444444",
  actionKind: "embedded" as const,
};

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const stored = () => JSON.parse(sessionStorage.getItem(CHECKOUT_CONTINUATION_KEY) ?? "null");
const storeRaw = (raw: string) => sessionStorage.setItem(CHECKOUT_CONTINUATION_KEY, raw);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_MS);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("persistCheckoutContinuation", () => {
  it("stamps the default phase and the shared lifetime on write", () => {
    persistCheckoutContinuation(MARKER);

    expect(stored().phase).toBe("action_issued");
    expect(stored().expiresAt).toBe(NOW_SECONDS + CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS);

    persistCheckoutContinuation({ ...MARKER, phase: "confirm_dispatched" });
    expect(stored().phase).toBe("confirm_dispatched");
  });

  it("rounds the stamp down to a whole second", () => {
    vi.setSystemTime(NOW_MS + 999);
    persistCheckoutContinuation(MARKER);

    expect(stored().expiresAt).toBe(NOW_SECONDS + CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS);
  });

  it("stores exactly the fields it was given plus the stamp", () => {
    persistCheckoutContinuation(MARKER);

    expect(stored()).toEqual({
      ...MARKER,
      phase: "action_issued",
      expiresAt: NOW_SECONDS + CHECKOUT_PAYMENT_CONTINUATION_TTL_SECONDS,
    });
    expect(Object.keys(stored())).toEqual([...Object.keys(MARKER), "phase", "expiresAt"]);
  });

  it("sweeps the retired storage name on write", () => {
    sessionStorage.setItem(LEGACY_CHECKOUT_CONTINUATION_KEY, "left by the previous deployment");

    persistCheckoutContinuation(MARKER);

    expect(sessionStorage.getItem(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBeNull();
    expect(readCheckoutContinuation()).not.toBeNull();
  });
});

describe("readCheckoutContinuation", () => {
  it("reads a marker with no phase and no expiry", () => {
    // The shape written before those two fields existed.
    storeRaw(JSON.stringify(MARKER));

    const marker = readCheckoutContinuation();

    expect(marker).toEqual(MARKER);
    expect(marker?.phase).toBeUndefined();
    expect(marker?.expiresAt).toBeUndefined();
  });

  it.each(["action_issued", "confirm_dispatched"] as const)("keeps the known phase %s", (phase) => {
    storeRaw(JSON.stringify({ ...MARKER, phase }));
    expect(readCheckoutContinuation()?.phase).toBe(phase);
  });

  it.each([
    ["a phase outside the known two", { phase: "done" }],
    ["a null phase", { phase: null }],
    ["a numeric phase", { phase: 1 }],
    ["an expiry that is text", { expiresAt: "soon" }],
    ["a null expiry", { expiresAt: null }],
  ])("drops a malformed phase or expiry and keeps the marker: %s", (_label, damage) => {
    storeRaw(JSON.stringify({ ...MARKER, phase: "confirm_dispatched", expiresAt: 1_000, ...damage }));

    const marker = readCheckoutContinuation();

    expect(marker).toMatchObject(MARKER);
    if ("phase" in damage) {
      expect(marker?.phase).toBeUndefined();
      expect(marker?.expiresAt).toBe(1_000);
    } else {
      expect(marker?.expiresAt).toBeUndefined();
      expect(marker?.phase).toBe("confirm_dispatched");
    }
  });

  it("drops an expiry that parses to infinity and keeps the marker", () => {
    // JSON.stringify cannot write this; a hand-edited record can.
    const raw = JSON.stringify({ ...MARKER, expiresAt: 0 }).replace('"expiresAt":0', '"expiresAt":1e999');
    expect(JSON.parse(raw).expiresAt).toBe(Infinity);
    storeRaw(raw);

    const marker = readCheckoutContinuation();

    expect(marker).toMatchObject(MARKER);
    expect(marker?.expiresAt).toBeUndefined();
  });

  it.each([0, -5, 12.5])("keeps a finite expiry as stored: %s", (expiresAt) => {
    storeRaw(JSON.stringify({ ...MARKER, expiresAt }));
    expect(readCheckoutContinuation()?.expiresAt).toBe(expiresAt);
  });

  it.each([
    ["orderId missing", { orderId: undefined }],
    ["orderRef missing", { orderRef: undefined }],
    ["paymentIntentId missing", { paymentIntentId: undefined }],
    ["clientId missing", { clientId: undefined }],
    ["journeyId missing", { journeyId: undefined }],
    ["orderId a number", { orderId: 1 }],
    ["orderRef a number", { orderRef: 1 }],
    ["paymentIntentId null", { paymentIntentId: null }],
    ["clientId a number", { clientId: 1 }],
    ["journeyId an object", { journeyId: {} }],
    ["actionKind missing", { actionKind: undefined }],
    ["actionKind unknown", { actionKind: "popup" }],
    ["actionKind in another case", { actionKind: "EMBEDDED" }],
    ["actionKind a number", { actionKind: 1 }],
  ])("returns null unless all five identifiers and a known action kind are present: %s", (_label, damage) => {
    storeRaw(JSON.stringify({ ...MARKER, ...damage }));
    expect(readCheckoutContinuation()).toBeNull();
  });

  it.each(["embedded", "redirect", "none"] as const)("accepts the action kind %s", (actionKind) => {
    storeRaw(JSON.stringify({ ...MARKER, actionKind }));
    expect(readCheckoutContinuation()?.actionKind).toBe(actionKind);
  });

  it.each([
    ["text that is not JSON", "not json"],
    ["JSON null", "null"],
    ["a JSON array", "[]"],
    ["an empty object", "{}"],
    ["an empty string", ""],
  ])("returns null for %s", (_label, raw) => {
    storeRaw(raw);
    expect(readCheckoutContinuation()).toBeNull();
  });

  it("returns null when nothing is stored", () => {
    expect(readCheckoutContinuation()).toBeNull();
  });

  it("accepts empty-string identifiers (pinned)", () => {
    // PINNED AS IT IS TODAY: the reader checks the type of each identifier, not
    // that it is non-empty. Tightening it is a separate behaviour change.
    const empty = { ...MARKER, orderId: "", orderRef: "", paymentIntentId: "", clientId: "", journeyId: "" };
    storeRaw(JSON.stringify(empty));

    expect(readCheckoutContinuation()).toMatchObject(empty);
  });

  it("passes an unknown extra field through unchanged (pinned)", () => {
    // PINNED AS IT IS TODAY: the reader validates the fields it knows and returns
    // everything else as stored, including the wait-exhaustion stamp. Validating
    // or stripping unknown fields is a separate behaviour change.
    storeRaw(JSON.stringify({ ...MARKER, waitExhaustedAt: 123, unknownField: { nested: true } }));

    const marker = readCheckoutContinuation() as Record<string, unknown> | null;

    expect(marker?.unknownField).toEqual({ nested: true });
    expect(marker?.waitExhaustedAt).toBe(123);
  });

  it("never reads the retired storage name", () => {
    sessionStorage.setItem(LEGACY_CHECKOUT_CONTINUATION_KEY, JSON.stringify({ ...MARKER, phase: "confirm_dispatched" }));

    expect(readCheckoutContinuation()).toBeNull();
  });
});

describe("setCheckoutContinuationPhase", () => {
  it("changes the phase in place and writes nothing when there is no marker", () => {
    persistCheckoutContinuation(MARKER);
    const before = stored();
    vi.setSystemTime(NOW_MS + 10 * 60 * 1000);

    setCheckoutContinuationPhase("confirm_dispatched");

    // Identity and expiry are those of the original write, not re-stamped.
    expect(stored()).toEqual({ ...before, phase: "confirm_dispatched" });
    expect(stored().expiresAt).toBe(before.expiresAt);

    sessionStorage.clear();
    const setItem = vi.spyOn(sessionStorage, "setItem");
    setCheckoutContinuationPhase("confirm_dispatched");

    expect(setItem).not.toHaveBeenCalled();
    expect(sessionStorage.getItem(CHECKOUT_CONTINUATION_KEY)).toBeNull();
  });

  it("writes nothing when the marker is already on that phase", () => {
    persistCheckoutContinuation({ ...MARKER, phase: "confirm_dispatched" });
    const setItem = vi.spyOn(sessionStorage, "setItem");

    setCheckoutContinuationPhase("confirm_dispatched");

    expect(setItem).not.toHaveBeenCalled();
  });

  it("walks a marker back to an earlier phase", () => {
    persistCheckoutContinuation({ ...MARKER, phase: "confirm_dispatched" });

    setCheckoutContinuationPhase("action_issued");

    expect(stored().phase).toBe("action_issued");
  });
});

describe("clearCheckoutContinuation", () => {
  it("removes both names and nothing else", () => {
    persistCheckoutContinuation(MARKER);
    sessionStorage.setItem(LEGACY_CHECKOUT_CONTINUATION_KEY, "left by the previous deployment");
    sessionStorage.setItem(CHECKOUT_ATTEMPT_STORAGE_KEY, "attempt record");
    sessionStorage.setItem("unrelated", "kept");

    clearCheckoutContinuation();

    expect(sessionStorage.getItem(CHECKOUT_CONTINUATION_KEY)).toBeNull();
    expect(sessionStorage.getItem(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBeNull();
    expect(sessionStorage.getItem(CHECKOUT_ATTEMPT_STORAGE_KEY)).toBe("attempt record");
    expect(sessionStorage.getItem("unrelated")).toBe("kept");
    expect(() => clearCheckoutContinuation()).not.toThrow();
  });
});

describe("storage that refuses a call", () => {
  function refuse(method: "getItem" | "setItem" | "removeItem") {
    vi.spyOn(sessionStorage, method).mockImplementation(() => {
      throw new Error(`storage refused ${method}`);
    });
  }

  it("never throws when a read is refused, and reads null", () => {
    persistCheckoutContinuation(MARKER);
    refuse("getItem");

    expect(() => persistCheckoutContinuation(MARKER)).not.toThrow();
    expect(() => setCheckoutContinuationPhase("confirm_dispatched")).not.toThrow();
    expect(() => clearCheckoutContinuation()).not.toThrow();
    expect(readCheckoutContinuation()).toBeNull();
  });

  it("never throws when a write is refused, and keeps the earlier marker", () => {
    persistCheckoutContinuation(MARKER);
    const before = sessionStorage.getItem(CHECKOUT_CONTINUATION_KEY);
    refuse("setItem");

    expect(() => persistCheckoutContinuation({ ...MARKER, orderRef: "another" })).not.toThrow();
    expect(() => setCheckoutContinuationPhase("confirm_dispatched")).not.toThrow();
    expect(sessionStorage.getItem(CHECKOUT_CONTINUATION_KEY)).toBe(before);

    sessionStorage.clear();
    expect(() => persistCheckoutContinuation(MARKER)).not.toThrow();
    expect(readCheckoutContinuation()).toBeNull();
  });

  it("never throws when a removal is refused, and the write before it still lands", () => {
    refuse("removeItem");

    // The marker is written first, then the retired name is swept; the refused
    // sweep is swallowed and does not undo the write.
    expect(() => persistCheckoutContinuation(MARKER)).not.toThrow();
    expect(readCheckoutContinuation()).toMatchObject(MARKER);
    expect(() => setCheckoutContinuationPhase("confirm_dispatched")).not.toThrow();
    expect(() => clearCheckoutContinuation()).not.toThrow();
    // The refused removal leaves the marker where it was.
    expect(readCheckoutContinuation()).toMatchObject(MARKER);
  });
});

describe("storage names", () => {
  it("keeps its two storage names", () => {
    // The current name is typed out; the retired name is pinned by digest so the
    // literal is not retyped here. A browser may hold either from the previous
    // deployment, so neither may move.
    expect(CHECKOUT_CONTINUATION_KEY).toBe("openlup:payment-continuation:v1");
    expect(sha256(LEGACY_CHECKOUT_CONTINUATION_KEY)).toBe(
      "60307c70af2575a59836a3807d923685507c6c0f0938717456b29984aeaabcd9",
    );
  });
});
