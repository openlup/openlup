import { afterEach, describe, expect, it, vi } from "vitest";

import {
  assertableHints,
  DECLINE_CODE_READBACK_TIMEOUT_MS,
  isMandateRefusal,
  lastRefusalRow,
  mandateCapabilityReadable,
  readAttemptDeclineCode,
  readAttemptDeclineObservation,
  states,
} from "./tpayDeclineEvidence.js";

/** A readback client whose single answer is `answer`, or which fails with it. */
function readbackClient(answer: unknown) {
  return {
    getTransaction: vi.fn(async () => {
      if (answer instanceof Error) throw answer;
      return answer;
    }),
  } as unknown as Parameters<typeof readAttemptDeclineCode>[0];
}

const attemptsOf = (...attempts: unknown[]) => ({ payments: { attempts } });

afterEach(() => {
  vi.useRealTimers();
});

describe("lastRefusalRow", () => {
  it("answers with the last row that carries a code, not the last row", () => {
    const found = lastRefusalRow(
      [
        { paymentErrorCode: "100", date: "26.08.2026 09:14" },
        { paymentErrorCode: "105", date: "26.08.2026 09:15" },
        { date: "26.08.2026 09:16" },
      ],
      "paymentErrorCode",
    );

    expect(found?.code).toBe("105");
    // The row travels back so a caller that needs the instant can read it here.
    expect(found?.row.date).toBe("26.08.2026 09:15");
  });

  it("reads the key it is given, so one scan serves both carriers", () => {
    const rows = [{ errorCode: "103", paymentErrorCode: "106" }];

    expect(lastRefusalRow(rows, "errorCode")?.code).toBe("103");
    expect(lastRefusalRow(rows, "paymentErrorCode")?.code).toBe("106");
  });

  it("trims a padded code rather than carrying transport whitespace forward", () => {
    expect(lastRefusalRow([{ paymentErrorCode: "  105  " }], "paymentErrorCode")?.code).toBe("105");
  });

  it.each([
    ["nothing", undefined],
    ["null", null],
    ["an object instead of a list", { paymentErrorCode: "105" }],
    ["a string", "105"],
    ["an empty list", []],
  ])("answers nothing for %s", (_label, rows) => {
    expect(lastRefusalRow(rows, "paymentErrorCode")).toBeNull();
  });

  it.each([
    ["a row that is not an object", "105"],
    ["a null row", null],
    ["a row without the key", { date: "26.08.2026 09:15" }],
    ["an empty code", { paymentErrorCode: "" }],
    ["a whitespace code", { paymentErrorCode: "   " }],
    // Only an explicit string is a code. A number would make `0` and `NaN`
    // arguable, and the transport hands these over as strings.
    ["a numeric code", { paymentErrorCode: 105 }],
  ])("skips %s", (_label, row) => {
    expect(lastRefusalRow([row], "paymentErrorCode")).toBeNull();
  });
});

describe("readAttemptDeclineCode", () => {
  it("answers with the code the attempt log currently stands on", async () => {
    const client = readbackClient(attemptsOf(
      { paymentErrorCode: "100" },
      { paymentErrorCode: "105" },
    ));

    await expect(readAttemptDeclineCode(client, "01HX")).resolves.toBe("105");
    expect(client.getTransaction).toHaveBeenCalledWith("01HX");
  });

  it("does not call the provider at all without a transaction to read", async () => {
    const client = readbackClient(attemptsOf({ paymentErrorCode: "105" }));

    await expect(readAttemptDeclineCode(client, "")).resolves.toBeNull();
    expect(client.getTransaction).not.toHaveBeenCalled();
  });

  it("answers nothing when the read fails outright", async () => {
    await expect(
      readAttemptDeclineCode(readbackClient(new Error("connection reset")), "01HX"),
    ).resolves.toBeNull();
  });

  it.each([
    ["an answer that is not an object", "01HX-body"],
    ["no answer at all", undefined],
    ["a body without payments", { transactionId: "01HX" }],
    ["payments that are not an object", { payments: "none" }],
    ["attempts that are not a list", { payments: { attempts: { paymentErrorCode: "105" } } }],
    ["an attempt log with no codes", attemptsOf({ date: "26.08.2026 09:15" })],
  ])("answers nothing for %s", async (_label, body) => {
    await expect(readAttemptDeclineCode(readbackClient(body), "01HX")).resolves.toBeNull();
  });

  it("gives up at its own deadline instead of holding the caller", async () => {
    vi.useFakeTimers();
    const client = { getTransaction: vi.fn(() => new Promise(() => {})) } as never;

    const pending = readAttemptDeclineCode(client, "01HX", 50);
    await vi.advanceTimersByTimeAsync(50);

    await expect(pending).resolves.toBeNull();
  });

  it("leaves nothing pending behind a read that answered in time", async () => {
    vi.useFakeTimers();

    await expect(
      readAttemptDeclineCode(readbackClient(attemptsOf({ paymentErrorCode: "105" })), "01HX"),
    ).resolves.toBe("105");
    // The deadline timer is cleared, so a finished read cannot hold a timer open
    // for the rest of its window.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives a read that fails AFTER the deadline has already passed", async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    const client = {
      getTransaction: vi.fn(() => new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error("connection reset")), 200);
      })),
    } as never;

    try {
      const pending = readAttemptDeclineCode(client, "01HX", 50);
      await vi.advanceTimersByTimeAsync(50);
      await expect(pending).resolves.toBeNull();

      // The late failure lands with nobody waiting; it must be absorbed, not
      // thrown at the process.
      await vi.advanceTimersByTimeAsync(200);
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("keeps a deadline short enough to stay inside the transport's own timeout", () => {
    expect(DECLINE_CODE_READBACK_TIMEOUT_MS).toBeLessThan(10_000);
  });
});

describe("states", () => {
  it.each([
    ["a hint", { hints: ["transient"] as const }, true],
    ["advice", { adviceCode: "do_not_try_again" as const }, true],
    // An empty hint list is still a statement: the caller declared the shape.
    ["an empty hint list", { hints: [] as const }, true],
    ["nothing", {}, false],
  ])("reports %s", (_label, reading, expected) => {
    expect(states(reading)).toBe(expected);
  });
});

describe("mandateCapabilityReadable", () => {
  it("reads bank capability only where a mandate is being registered", () => {
    expect(mandateCapabilityReadable("blik_recurring_activation")).toBe(true);
  });

  it.each(["blik_one_time", "blik_one_click", "pbl_one_time", "recurring_charge"])(
    "refuses to read it on %s, where a refusal says something else",
    (flow) => {
      expect(mandateCapabilityReadable(flow)).toBe(false);
    },
  );

  it("treats an unestablished flow as fail-closed rather than as absent", () => {
    // `null` is the answer of an observer that cannot tell which flow it saw.
    // Unknown must never license the claim: that is the whole reason the rule
    // takes the flow instead of asking each rail to remember it.
    expect(mandateCapabilityReadable(null)).toBe(false);
  });
});

describe("assertableHints", () => {
  it("passes the bank claim through for a registration, whole and by identity", () => {
    const hints = ["mandateUnsupported"] as const;
    expect(assertableHints(hints, "blik_recurring_activation")).toBe(hints);
  });

  it.each(["recurring_charge", "blik_one_time", "blik_one_click", "pbl_one_time"])(
    "withholds the bank claim on %s",
    (flow) => {
      expect(assertableHints(["mandateUnsupported"], flow)).toEqual([]);
    },
  );

  it("withholds it from an observer that cannot establish the flow", () => {
    expect(assertableHints(["mandateUnsupported"], null)).toEqual([]);
  });

  // The funnel is one hint wide. Everything else states something about the
  // charge rather than about the payer's bank, and survives every context.
  it.each([
    ["transient"],
    ["limitExceeded"],
    ["credentialDead"],
    ["dataInvalid"],
    ["authenticationRequired"],
  ] as const)("never withholds %s, whatever the flow", (hint) => {
    for (const flow of ["blik_recurring_activation", "recurring_charge", null]) {
      expect(assertableHints([hint], flow)).toEqual([hint]);
    }
  });

  it("keeps the other hints when it drops the bank claim from a mixed reading", () => {
    expect(assertableHints(["mandateUnsupported", "transient"], null)).toEqual(["transient"]);
  });

  it("distinguishes a reading that says nothing from one that says nothing usable", () => {
    // `undefined` is "no reading at all" and must stay itself: the execution
    // path spreads the result conditionally, and an empty array is a shape the
    // caller declared rather than the absence of one.
    expect(assertableHints(undefined, null)).toBeUndefined();
    expect(assertableHints(undefined, "blik_recurring_activation")).toBeUndefined();
    expect(assertableHints([], null)).toEqual([]);
  });

  it("does not mutate the reading it filters", () => {
    // The reading tables are frozen and shared by every caller; a funnel that
    // edited one in place would re-point a row for everybody.
    const hints = Object.freeze(["mandateUnsupported", "transient"] as const);
    expect(assertableHints(hints, null)).toEqual(["transient"]);
    expect(hints).toEqual(["mandateUnsupported", "transient"]);
  });
});

describe("isMandateRefusal", () => {
  const denial = "Bank nie umożliwia rejestracji aliasu dla płatności powtarzalnych";

  it("needs BOTH a named mandate and a denied capability", () => {
    expect(isMandateRefusal("blik_recurring_activation", null, denial)).toBe(true);
  });

  it.each([
    ["a mandate named without any denial", "Niepoprawny alias PAYID"],
    ["a denial that names no mandate", "Bank nie obsługuje tej operacji"],
    ["an unrelated refusal", "Niepoprawny kod BLIK"],
    ["an empty message", ""],
  ])("stays silent on %s", (_label, message) => {
    expect(isMandateRefusal("blik_recurring_activation", null, message)).toBe(false);
  });

  it("reads the message through folded diacritics, not raw bytes", () => {
    expect(isMandateRefusal(
      "blik_recurring_activation",
      null,
      "Bank nie umozliwia rejestracji aliasu POWTARZALNEGO",
    )).toBe(true);
  });

  it("reads the same denial phrased in English", () => {
    expect(isMandateRefusal(
      "blik_recurring_activation",
      null,
      "recurring alias is not supported by this bank",
    )).toBe(true);
  });

  it.each(["blik_one_time", "blik_one_click", "pbl_one_time", "recurring_charge"])(
    "never claims bank capability outside registration (%s)",
    (flow) => {
      // A refused charge on an existing mandate proves the bank can hold one.
      expect(isMandateRefusal(flow, null, denial)).toBe(false);
    },
  );

  it("is vetoed by the provider's own statement that the mandate rail is available", () => {
    expect(isMandateRefusal("blik_recurring_activation", true, denial)).toBe(false);
    // Absent and false are not the same as true: absence is uninformative here,
    // and it is the value EVERY rejection carries.
    expect(isMandateRefusal("blik_recurring_activation", false, denial)).toBe(true);
  });
});


describe("readback dispositions", () => {
  it.each([
    [{ payments: { attempts: [{ paymentErrorCode: "105" }] } }, { code: "105", disposition: "present" }],
    [{ payments: { attempts: [] } }, { code: null, disposition: "absent" }],
    [{ payments: { attempts: "broken" } }, { code: null, disposition: "unreadable" }],
    [{ payments: { attempts: [{ paymentErrorCode: 105 }] } }, { code: null, disposition: "unreadable" }],
    [null, { code: null, disposition: "unreadable" }],
    [new Error("private response"), { code: null, disposition: "read_failed" }],
  ])("distinguishes diagnostic failure from absent codes", async (body, expected) => {
    const client = readbackClient(body);
    expect(await readAttemptDeclineObservation(client, "01HX")).toEqual(expected);
    expect(client.getTransaction).toHaveBeenCalledTimes(1);
  });

  it("reports the same 3-second timeout and handles a later rejected read", async () => {
    vi.useFakeTimers();
    let rejectRead!: (reason: Error) => void;
    const client = { getTransaction: vi.fn(() => new Promise((_, reject) => { rejectRead = reject; })) } as unknown as Parameters<typeof readAttemptDeclineCode>[0];
    const result = readAttemptDeclineObservation(client, "01HX");
    await vi.advanceTimersByTimeAsync(3000);
    expect(await result).toEqual({ code: null, disposition: "read_timeout" });
    rejectRead(new Error("late private response"));
    await vi.runAllTimersAsync();
    expect(client.getTransaction).toHaveBeenCalledTimes(1);
  });
});


describe("diagnostic transaction correlation", () => {
  it("quarantines a different transaction without changing the legacy code", async () => {
    const client = readbackClient({ transactionId: "tx_other", payments: { attempts: [{ paymentErrorCode: "105" }] } });
    expect(await readAttemptDeclineObservation(client, "tx_expected")).toEqual({
      code: "105", disposition: "unreadable", identityMismatch: true,
    });
    expect(client.getTransaction).toHaveBeenCalledTimes(1);
    expect(await readAttemptDeclineCode(client, "tx_expected")).toBe("105");
  });
});
