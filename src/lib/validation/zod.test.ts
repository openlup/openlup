import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
}));

vi.mock("zod", () => ({
  z: {
    config: mocks.config,
  },
}));

describe("browser Zod wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.config.mockClear();
  });

  it("disables runtime code generation for CSP-safe browser validation", async () => {
    await import("@/lib/validation/zod");

    expect(mocks.config).toHaveBeenCalledOnce();
    expect(mocks.config).toHaveBeenCalledWith({ jitless: true });
  });
});
