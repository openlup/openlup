import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCAL_ESLINT_CONCURRENCY,
  eslintInvocation,
  resolveEslintConcurrency,
} from "./run-eslint.mjs";

describe("run-eslint", () => {
  it("keeps --concurrency auto on hosted CI", () => {
    expect(resolveEslintConcurrency(["."], { CI: "true" })).toBe("auto");
  });

  it("caps local concurrency by default", () => {
    expect(resolveEslintConcurrency(["."], {})).toBe(DEFAULT_LOCAL_ESLINT_CONCURRENCY);
    const invocation = eslintInvocation(["."], {});
    expect(invocation.args).toEqual(["--concurrency", "2", "."]);
  });

  it("honours explicit OPENLUP_ESLINT_CONCURRENCY locally", () => {
    expect(resolveEslintConcurrency(["."], { OPENLUP_ESLINT_CONCURRENCY: "3" })).toBe("3");
    expect(resolveEslintConcurrency(["."], { OPENLUP_ESLINT_CONCURRENCY: "off" })).toBe("off");
    expect(resolveEslintConcurrency(["."], { OPENLUP_ESLINT_CONCURRENCY: "0" })).toBe("2");
  });

  it("derives local concurrency from broker CPU tokens up to the cap", () => {
    expect(resolveEslintConcurrency(["."], { AI_RESOURCE_GATE_CPU_TOKENS: "3" })).toBe("3");
    expect(resolveEslintConcurrency(["."], { AI_RESOURCE_GATE_CPU_TOKENS: "12" })).toBe("4");
  });

  it("preserves caller-supplied --concurrency flags", () => {
    expect(resolveEslintConcurrency(["--concurrency", "1", "."], {})).toBeNull();
    expect(resolveEslintConcurrency(["--concurrency=auto", "."], {})).toBeNull();
    expect(eslintInvocation(["--concurrency=1", "."], {}).args).toEqual(["--concurrency=1", "."]);
  });
});
