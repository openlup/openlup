import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  config: vi.fn(),
  construct: vi.fn(),
}));

vi.mock("zod", async (importOriginal) => {
  const real = await importOriginal<typeof import("zod")>();
  mocks.config.mockImplementation(real.z.config);
  return {
    ...real,
    z: {
      ...real.z,
      config: mocks.config,
      string: (...args: Parameters<typeof real.z.string>) => {
        mocks.construct("string");
        return real.z.string(...args);
      },
      object: (...args: Parameters<typeof real.z.object>) => {
        mocks.construct("object");
        return real.z.object(...args);
      },
    },
  };
});

describe("marketing cold-import validation", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.config.mockClear();
    mocks.construct.mockClear();
  });

  it.each([
    { entry: "index", load: () => import("../../src/marketing/index.js") },
    { entry: "acquisitionCaseSchemas", load: () => import("../../src/marketing/acquisitionCaseSchemas.js") },
    { entry: "acquisitionEvidenceSchemas", load: () => import("../../src/marketing/acquisitionEvidenceSchemas.js") },
    { entry: "prelaunchAcquisitionSchemas", load: () => import("../../src/marketing/prelaunchAcquisitionSchemas.js") },
  ])("configures jitless before constructing schemas through $entry", async ({ load }) => {
    await load();

    expect(mocks.config).toHaveBeenCalledWith({ jitless: true });
    expect(mocks.construct).toHaveBeenCalled();
    expect(mocks.config.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.construct.mock.invocationCallOrder[0],
    );
  });
});
