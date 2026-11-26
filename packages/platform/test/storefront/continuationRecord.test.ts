import { describe, expect, it } from "vitest";
import {
  advanceAttempt,
  clearContinuationRecord,
  getOrCreateContinuationId,
  readContinuationRecord,
  toAttemptNumber,
  toContinuationId,
  type ContinuationRecord,
  type ContinuationRecordStorageBinding,
  type IdentifierBinding,
  type StorageFailurePolicy,
} from "../../src/storefront/index.js";

type Call = { binding: string; argument?: unknown };

/** In-memory bindings that record every call, in order, across storage, identifier and fingerprint. */
function harness(initial: ContinuationRecord | null = null, options: {
  accepts?: (value: string) => boolean; dropWrites?: boolean; keeps?: (written: ContinuationRecord) => ContinuationRecord;
} = {}) {
  let stored = initial;
  let minted = 0;
  const calls: Call[] = [];
  const storage: ContinuationRecordStorageBinding = {
    read: () => {
      calls.push({ binding: "read" });
      return stored;
    },
    write: (record) => {
      calls.push({ binding: "write", argument: record });
      if (!options.dropWrites) stored = options.keeps ? options.keeps(record) : record;
    },
    clear: () => {
      calls.push({ binding: "clear" });
      stored = null;
    },
  };
  const identifier: IdentifierBinding = {
    next: () => {
      minted += 1;
      calls.push({ binding: "next" });
      return `minted-${minted}`;
    },
    accepts: (value) => {
      calls.push({ binding: "accepts", argument: value });
      return (options.accepts ?? (candidate => candidate.startsWith("minted-")))(value);
    },
  };
  const fingerprint = () => {
    calls.push({ binding: "fingerprint" });
    return "stamp";
  };
  return { storage, identifier, fingerprint, calls, stored: () => stored };
}

const record = (continuationId: string, attempt?: number): ContinuationRecord => ({
  continuationId: toContinuationId(continuationId),
  fingerprint: "first-stamp",
  ...(attempt === undefined ? {} : { attempt: toAttemptNumber(attempt) }),
});

const thrownBy = (run: () => unknown): unknown => {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
};

describe("getOrCreateContinuationId", () => {
  it("reuse never calls fingerprint and writes nothing", () => {
    const kept = record("minted-7", 2);
    const bindings = harness(kept);

    expect(getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint })).toBe("minted-7");

    expect(bindings.calls).toEqual([{ binding: "read" }, { binding: "accepts", argument: "minted-7" }]);
    expect(bindings.stored()).toBe(kept);
  });

  it("mints by calling next then fingerprint, once each, and writes no attempt", () => {
    const bindings = harness();

    const id = getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint });

    expect(id).toBe("minted-1");
    expect(bindings.calls.map(call => call.binding)).toEqual(["read", "next", "fingerprint", "write", "read"]);
    expect(bindings.stored()).toStrictEqual({ fingerprint: "stamp", continuationId: "minted-1" });
  });

  it("mints over a record the identifier rejects and writes exactly the new fingerprint and identity", () => {
    const bindings = harness(record("foreign-format", 4));

    const id = getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint });

    expect(id).toBe("minted-1");
    expect(bindings.calls.map(call => call.binding)).toEqual(["read", "accepts", "next", "fingerprint", "write", "read"]);
    const written = bindings.calls.find(call => call.binding === "write")?.argument;
    expect(written).toStrictEqual({ fingerprint: "stamp", continuationId: "minted-1" });
    expect(Object.keys(written as object).sort()).toEqual(["continuationId", "fingerprint"]);
  });

  it("keeps one identity across calls once the first one is stored", () => {
    const bindings = harness();
    const first = getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint });
    const second = getOrCreateContinuationId(bindings, { fingerprint: () => "another-stamp" });

    expect(second).toBe(first);
    expect(bindings.stored()).toStrictEqual({ fingerprint: "stamp", continuationId: "minted-1" });
  });

  it("mints a fresh identity only after the record is cleared", () => {
    const bindings = harness();
    expect(getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint })).toBe("minted-1");

    clearContinuationRecord(bindings);

    expect(getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint })).toBe("minted-2");
  });

  it("yields a new identity per call when the storage binding drops every write", () => {
    const bindings = harness(null, { dropWrites: true });
    const input = { fingerprint: bindings.fingerprint, storageFailure: "continue_unpersisted" } as const;

    const first = getOrCreateContinuationId(bindings, input);
    const firstCalls = bindings.calls.splice(0).map(call => call.binding);
    const second = getOrCreateContinuationId(bindings, input);

    expect([first, second]).toEqual(["minted-1", "minted-2"]);
    // No read follows the write: the earlier call sequence, call for call.
    expect([firstCalls, bindings.calls.map(call => call.binding)]).toEqual([
      ["read", "next", "fingerprint", "write"],
      ["read", "next", "fingerprint", "write"],
    ]);
    expect(bindings.stored()).toBeNull();
  });
});

describe("storage failure", () => {
  it("refuses by default when the storage drops the mint write", () => {
    const bindings = harness(null, { dropWrites: true });

    expect(getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint })).toBeNull();
    expect(bindings.calls.map(call => call.binding)).toEqual(["read", "next", "fingerprint", "write", "read"]);

    bindings.calls.splice(0);
    expect(getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint })).toBeNull();
    expect(bindings.calls.map(call => call.binding)).toEqual(["read", "next", "fingerprint", "write", "read"]);
    expect(bindings.calls.find(call => call.binding === "write")?.argument).toStrictEqual({ fingerprint: "stamp", continuationId: "minted-2" });
  });

  it("refuses under refuse and under a member it does not know", () => {
    for (const storageFailure of ["refuse", "policy_added_later"] as StorageFailurePolicy[]) {
      const bindings = harness(null, { dropWrites: true });

      expect(getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint, storageFailure })).toBeNull();
      expect(bindings.calls.map(call => call.binding)).toEqual(["read", "next", "fingerprint", "write", "read"]);
    }
  });

  it("refuses when the record read back names another identity", () => {
    const bindings = harness(null, { keeps: written => ({ ...written, continuationId: toContinuationId("minted-other") }) });

    expect(getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint })).toBeNull();
    expect(bindings.calls.filter(call => call.binding === "next")).toHaveLength(1);
  });

  it("refuses when the record read back carries another fingerprint", () => {
    const bindings = harness(null, { keeps: written => ({ ...written, fingerprint: "another-stamp" }) });

    expect(getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint })).toBeNull();
    expect(bindings.calls.filter(call => call.binding === "next")).toHaveLength(1);
  });

  it("accepts a read-back that adds attempt zero", () => {
    const bindings = harness(null, { keeps: written => ({ ...written, attempt: toAttemptNumber(0) }) });

    expect(getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint })).toBe("minted-1");
    expect(bindings.calls.map(call => call.binding)).toEqual(["read", "next", "fingerprint", "write", "read"]);
  });

  it("propagates a read-back error as the same object", () => {
    const bindings = harness();
    const refusal = new Error("storage refused the read-back");
    const read = bindings.storage.read;
    let reads = 0;
    bindings.storage.read = () => {
      reads += 1;
      if (reads === 2) throw refusal;
      return read();
    };

    expect(thrownBy(() => getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint }))).toBe(refusal);
    expect(bindings.calls.map(call => call.binding)).toEqual(["read", "next", "fingerprint", "write"]);
  });

  it("does not read back after a write that throws", () => {
    const bindings = harness();
    const refusal = new Error("storage refused write");
    bindings.storage.write = (written) => {
      bindings.calls.push({ binding: "write", argument: written });
      throw refusal;
    };

    expect(thrownBy(() => getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint }))).toBe(refusal);
    expect(bindings.calls.map(call => call.binding)).toEqual(["read", "next", "fingerprint", "write"]);
  });
});

describe("readContinuationRecord", () => {
  it("returns the stored record unchanged, even one the identifier rejects, without checking or writing", () => {
    const rejected = record("foreign-format", 3);
    const bindings = harness(rejected, { accepts: () => false });

    expect(readContinuationRecord(bindings)).toBe(rejected);
    expect(bindings.calls).toEqual([{ binding: "read" }]);
  });

  it("returns null when nothing is stored", () => {
    const bindings = harness();

    expect(readContinuationRecord(bindings)).toBeNull();
    expect(bindings.calls).toEqual([{ binding: "read" }]);
  });
});

describe("advanceAttempt", () => {
  it("advances by one and keeps the identity and the fingerprint", () => {
    const bindings = harness(record("minted-3", 1));

    advanceAttempt(bindings);
    expect(bindings.stored()).toStrictEqual({ continuationId: "minted-3", fingerprint: "first-stamp", attempt: 2 });

    advanceAttempt(bindings);
    expect(bindings.stored()?.attempt).toBe(3);
    expect(bindings.calls.map(call => call.binding)).toEqual(["read", "write", "read", "write"]);
  });

  it("reads an absent attempt as zero", () => {
    const bindings = harness(record("minted-3"));

    advanceAttempt(bindings);

    expect(bindings.stored()).toStrictEqual({ continuationId: "minted-3", fingerprint: "first-stamp", attempt: 1 });
  });

  it("advances a record the identifier rejects", () => {
    const bindings = harness(record("foreign-format", 2), { accepts: () => false });

    advanceAttempt(bindings);

    expect(bindings.stored()).toStrictEqual({ continuationId: "foreign-format", fingerprint: "first-stamp", attempt: 3 });
    expect(bindings.calls.map(call => call.binding)).toEqual(["read", "write"]);
  });

  it("writes nothing when no record is stored", () => {
    const bindings = harness();

    advanceAttempt(bindings);

    expect(bindings.calls).toEqual([{ binding: "read" }]);
    expect(bindings.stored()).toBeNull();
  });
});

describe("clearContinuationRecord", () => {
  it("clears through the storage binding only", () => {
    const bindings = harness(record("minted-1"));

    clearContinuationRecord(bindings);

    expect(bindings.calls).toEqual([{ binding: "clear" }]);
    expect(bindings.stored()).toBeNull();
  });
});

describe("a binding error", () => {
  const failing = (method: keyof ContinuationRecordStorageBinding, initial: ContinuationRecord | null) => {
    const bindings = harness(initial);
    const refusal = new Error(`storage refused ${method}`);
    bindings.storage[method] = () => {
      throw refusal;
    };
    return { bindings, refusal };
  };

  it("propagates a read error as the same object from every function that reads", () => {
    const { bindings, refusal } = failing("read", null);

    expect(thrownBy(() => getOrCreateContinuationId(bindings, { fingerprint: bindings.fingerprint }))).toBe(refusal);
    expect(thrownBy(() => readContinuationRecord(bindings))).toBe(refusal);
    expect(thrownBy(() => advanceAttempt(bindings))).toBe(refusal);
  });

  it("propagates a write error as the same object from mint and advance", () => {
    const empty = failing("write", null);
    expect(thrownBy(() => getOrCreateContinuationId(empty.bindings, { fingerprint: empty.bindings.fingerprint }))).toBe(empty.refusal);

    const kept = failing("write", record("minted-1"));
    expect(thrownBy(() => advanceAttempt(kept.bindings))).toBe(kept.refusal);
  });

  it("propagates a clear error as the same object", () => {
    const { bindings, refusal } = failing("clear", record("minted-1"));

    expect(thrownBy(() => clearContinuationRecord(bindings))).toBe(refusal);
  });

  it("propagates an identifier or fingerprint error as the same object and writes nothing", () => {
    const bindings = harness();
    const refusal = new Error("no identifier");
    const identifier: IdentifierBinding = { ...bindings.identifier, next: () => { throw refusal; } };
    expect(thrownBy(() => getOrCreateContinuationId({ storage: bindings.storage, identifier }, { fingerprint: bindings.fingerprint }))).toBe(refusal);

    const stampRefusal = new Error("no fingerprint");
    expect(thrownBy(() => getOrCreateContinuationId(bindings, { fingerprint: () => { throw stampRefusal; } }))).toBe(stampRefusal);
    expect(bindings.calls.some(call => call.binding === "write")).toBe(false);
  });
});
