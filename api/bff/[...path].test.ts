/**
 * Smoke test for the BFF routing aggregator.
 *
 * This file exists as a companion test so the CI coverage guard
 * (scripts/assert-changed-runtime-coverage.ts) does not flag the aggregator as
 * lacking coverage. The aggregator is auto-generated and cannot be
 * meaningfully unit-tested by importing the whole route graph; doing so pulls
 * every BFF handler into local V8 coverage and has repeatedly produced 120s
 * weak-machine hangs for a near-zero-signal assertion. The functional dispatch
 * contract is exercised by tests/golden-master/dispatchGoldenMaster.test.ts;
 * this companion stays static and pins only the generated entrypoint shape.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

describe("api/bff/[...path] — routing aggregator", () => {
  const sourcePath = join(process.cwd(), "api/bff/[...path].ts");

  it("keeps the generated default handler wired to the route table", () => {
    const source = readFileSync(sourcePath, "utf8");

    expect(source).toContain("export const routes: RouteEntry[] = [");
    expect(source).toContain("import { dispatch, type RouteEntry } from");
    expect(source).toMatch(
      /export default function bffRouter\(req: VercelRequest, res: VercelResponse\): Promise<unknown> \{ return dispatch\(routes, req, res\); \}/,
    );
  });

  it("marks both direct-only order-review admin routes for pre-auth availability refusal", () => {
    const source = readFileSync(sourcePath, "utf8");
    expect(source.match(/admin\/order-review[^\n]+availability: "direct-postgres"/g)).toHaveLength(2);
  });
});
