import { describe, expect, it, vi } from "vitest";

import {
  advisoryLockKey,
  createEnvAdvisoryLock,
  createNoopAdvisoryLock,
  createPgAdvisoryLock,
  type AdvisoryLockQuerier,
} from "../../src/scheduler/advisoryLock.js";

describe("advisoryLockKey", () => {
  it("is deterministic and stable per jobId", () => {
    expect(advisoryLockKey("outbox-dispatch")).toBe(advisoryLockKey("outbox-dispatch"));
  });
  it("distinguishes different jobs", () => {
    expect(advisoryLockKey("cleanup")).not.toBe(advisoryLockKey("nightly-report"));
  });
  it("produces a signed 32-bit int", () => {
    const key = advisoryLockKey("subscription-renewal");
    expect(Number.isInteger(key)).toBe(true);
    expect(key).toBeGreaterThanOrEqual(-(2 ** 31));
    expect(key).toBeLessThanOrEqual(2 ** 31 - 1);
  });
});

describe("createPgAdvisoryLock", () => {
  it("acquires via pg_try_advisory_lock with the hashed key", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ locked: true }] });
    const client: AdvisoryLockQuerier = { query };
    const lock = createPgAdvisoryLock(client);
    expect(lock.durability).toBe("cluster");
    await expect(lock.tryAcquire("cleanup")).resolves.toBe(true);
    expect(query).toHaveBeenCalledWith(
      "SELECT pg_try_advisory_lock($1) AS locked",
      [advisoryLockKey("cleanup")],
    );
  });

  it("returns false when the lock is not granted (another instance holds it)", async () => {
    const lock = createPgAdvisoryLock({
      query: vi.fn().mockResolvedValue({ rows: [{ locked: false }] }),
    });
    await expect(lock.tryAcquire("cleanup")).resolves.toBe(false);
  });

  it("reserves pending and held numeric keys, including colliding job IDs", async () => {
    let grant!: (value: { rows: { locked: boolean }[] }) => void;
    const pending = new Promise<{ rows: { locked: boolean }[] }>((resolve) => { grant = resolve; });
    const query = vi.fn().mockReturnValueOnce(pending).mockResolvedValue({ rows: [{ locked: true }] });
    const lock = createPgAdvisoryLock({ query });
    // These different identifiers share the actual FNV-1a PostgreSQL key.
    expect(advisoryLockKey("costarring")).toBe(advisoryLockKey("liquid"));
    const acquiring = lock.tryAcquire("costarring");
    await expect(lock.tryAcquire("costarring")).resolves.toBe(false);
    await expect(lock.tryAcquire("liquid")).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
    grant({ rows: [{ locked: true }] });
    await expect(acquiring).resolves.toBe(true);
    await expect(lock.tryAcquire("liquid")).resolves.toBe(false);
    await lock.release("costarring");
    await expect(lock.tryAcquire("liquid")).resolves.toBe(true);
    await lock.release("liquid");
  });

  it("clears a reservation after refused or failed acquisition", async () => {
    const failure = new Error("query failed");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: false }] })
      .mockRejectedValueOnce(failure)
      .mockResolvedValue({ rows: [{ locked: true }] });
    const lock = createPgAdvisoryLock({ query });
    await expect(lock.tryAcquire("cleanup")).resolves.toBe(false);
    await expect(lock.tryAcquire("cleanup")).rejects.toBe(failure);
    await expect(lock.tryAcquire("cleanup")).resolves.toBe(true);
    expect(query).toHaveBeenCalledTimes(3);
    await lock.release("cleanup");
  });

  it("keeps a failed unlock reserved through session close", async () => {
    const failure = new Error("unlock failed");
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{ locked: true }] })
      .mockRejectedValueOnce(failure);
    const end = vi.fn().mockResolvedValue(undefined);
    const lock = createPgAdvisoryLock({ query, end });
    await lock.tryAcquire("cleanup");
    await expect(lock.release("cleanup")).rejects.toBe(failure);
    await expect(lock.tryAcquire("cleanup")).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(2);
    await lock.close();
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("releases via pg_advisory_unlock with the same key", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    const lock = createPgAdvisoryLock({ query });
    await lock.release("cleanup");
    expect(query).toHaveBeenCalledWith("SELECT pg_advisory_unlock($1)", [advisoryLockKey("cleanup")]);
  });

  it("closes a dedicated pg session once even when the host asks twice", async () => {
    const end = vi.fn().mockResolvedValue(undefined);
    const lock = createPgAdvisoryLock({ query: vi.fn(), end });

    await Promise.all([lock.close(), lock.close()]);

    expect(end).toHaveBeenCalledTimes(1);
  });
});

describe("createNoopAdvisoryLock", () => {
  it("always grants", async () => {
    const lock = createNoopAdvisoryLock();
    expect(lock.durability).toBe("process");
    await expect(lock.tryAcquire("x")).resolves.toBe(true);
    await expect(lock.release("x")).resolves.toBeUndefined();
    await expect(lock.close()).resolves.toBeUndefined();
  });
});

describe("createEnvAdvisoryLock", () => {
  it("returns null when the environment declares no connection string", () => {
    expect(createEnvAdvisoryLock({})).toBeNull();
    expect(createEnvAdvisoryLock({ DATABASE_URL: "   " })).toBeNull();
  });

  it("connects lazily and reuses ONE connection across acquire and release", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ locked: true }] });
    const connect = vi.fn().mockResolvedValue({ query } as AdvisoryLockQuerier);
    const lock = createEnvAdvisoryLock({ DATABASE_URL: "postgres://host/db" }, connect);

    // Building the lock must not open anything: a host that never fires a timer never connects.
    expect(connect).not.toHaveBeenCalled();

    await expect(lock!.tryAcquire("probe")).resolves.toBe(true);
    await lock!.release("probe");

    // Session-scoped locks demand the same connection for acquire and release.
    expect(connect).toHaveBeenCalledTimes(1);
    expect(connect).toHaveBeenCalledWith("postgres://host/db");
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("never connects before a tick and closes the first-tick dedicated client exactly once", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ locked: true }] });
    const end = vi.fn().mockResolvedValue(undefined);
    const connect = vi.fn().mockResolvedValue({ query, end } as AdvisoryLockQuerier);
    const lock = createEnvAdvisoryLock({ DATABASE_URL: "postgres://host/db" }, connect)!;

    await lock.close();
    expect(connect).not.toHaveBeenCalled();

    const active = createEnvAdvisoryLock({ DATABASE_URL: "postgres://host/db" }, connect)!;
    await active.tryAcquire("probe");
    await Promise.all([active.close(), active.close()]);

    expect(connect).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledTimes(1);
  });
});
