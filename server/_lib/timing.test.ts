import { describe, expect, it, vi } from "vitest";
import { padResponseTime } from "./timing.js";

describe("padResponseTime", () => {
  it("sleeps for the remaining floor when the path returned early", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    // startedAt 0, now 50 → elapsed 50, minMs 400 → remaining 350.
    const now = vi.fn().mockReturnValue(50);

    await padResponseTime(0, 400, now, sleep);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(350);
  });

  it("does not sleep when elapsed exactly meets the floor", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    // elapsed 400, minMs 400 → remaining 0.
    const now = vi.fn().mockReturnValue(400);

    await padResponseTime(0, 400, now, sleep);

    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not sleep when elapsed already exceeds the floor (clamped to 0)", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    // elapsed 500, minMs 400 → remaining clamped to 0.
    const now = vi.fn().mockReturnValue(500);

    await padResponseTime(0, 400, now, sleep);

    expect(sleep).not.toHaveBeenCalled();
  });
});
