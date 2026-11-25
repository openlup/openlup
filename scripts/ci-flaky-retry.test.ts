import { describe, expect, it } from "vitest";
import { FLAKY_RETRY_PREFIX, formatFlakyRetryLines, isHostedCi, reportFlakyRetries } from "./ci-flaky-retry.mjs";

describe("ci-flaky-retry", () => {
  it("enables the retry only in hosted CI", () => {
    expect(isHostedCi({ CI: "true" })).toBe(true);
    expect(isHostedCi({ CI: "1" })).toBe(false);
    expect(isHostedCi({})).toBe(false);
  });

  it("prints a marker line and a warning annotation for every retried name", () => {
    expect(formatFlakyRetryLines(["a.test.ts", "bad%\nname"])).toEqual([
      "flaky-retry-passed: a.test.ts",
      "::warning title=Flaky test retried::a.test.ts",
      "flaky-retry-passed: bad%\nname",
      "::warning title=Flaky test retried::bad%25%0Aname",
    ]);
  });

  it("appends to the step summary only when one is set and never stays silent", () => {
    const lines: string[] = [];
    const appended: [string, string][] = [];
    const append = (path: string, text: string) => { appended.push([path, text]); };
    reportFlakyRetries(["a.test.ts", "group 2"], { env: {}, log: (line: string) => lines.push(line), append });
    expect(lines.filter((line) => line.startsWith(FLAKY_RETRY_PREFIX))).toHaveLength(2);
    expect(lines.filter((line) => line.startsWith("::warning title=Flaky test retried::"))).toHaveLength(2);
    expect(appended).toEqual([]);

    reportFlakyRetries(["a.test.ts"], { env: { GITHUB_STEP_SUMMARY: "/summary.md" }, log: () => {}, append });
    expect(appended).toEqual([["/summary.md", "- flaky-retry-passed: `a.test.ts`\n"]]);

    reportFlakyRetries([], { env: { GITHUB_STEP_SUMMARY: "/summary.md" }, log: () => { throw new Error("unexpected"); }, append });
    expect(appended).toHaveLength(1);
  });
});
