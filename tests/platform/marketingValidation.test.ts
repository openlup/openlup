import { readFileSync } from "node:fs";
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

describe("marketing reference initialization", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.config.mockClear();
    mocks.construct.mockClear();
  });

  it.each([
    ["../../src/domains/clients/acquisitionCaseContracts.ts", "../../lib/validation/zod.js"],
    ["../../src/domains/marketing/research/acquisitionEvidenceContracts.ts", "../../../lib/validation/zod.js"],
    ["../../src/domains/marketing/prelaunch/contracts.ts", "../../../lib/validation/zod.js"],
  ])("keeps the validation wrapper first in %s", (facade, wrapper) => {
    const source = readFileSync(new URL(facade, import.meta.url), "utf8");
    const firstDependency = source.match(/^(?:import|export)\b[^;]*?["']([^"']+)["']/m);
    expect(firstDependency?.[1]).toBe(wrapper);
  });

  it.each([
    { entry: "case facade", load: () => import("../../src/domains/clients/acquisitionCaseContracts.js") },
    { entry: "evidence facade", load: () => import("../../src/domains/marketing/research/acquisitionEvidenceContracts.js") },
    { entry: "prelaunch facade", load: () => import("../../src/domains/marketing/prelaunch/contracts.js") },
    { entry: "case adapter", load: () => import("../../server/adapters/postgres/clients/acquisitionCaseRoutines.js") },
    { entry: "evidence adapter", load: () => import("../../server/adapters/postgres/marketing/acquisitionEvidenceRoutines.js") },
  ])("configures jitless before schema construction through $entry", async ({ load }) => {
    await load();

    expect(mocks.config).toHaveBeenCalledWith({ jitless: true });
    expect(mocks.construct).toHaveBeenCalled();
    expect(mocks.config.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.construct.mock.invocationCallOrder[0],
    );
  });
});
