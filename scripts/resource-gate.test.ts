import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_EXECUTION_TIMEOUT_SECONDS,
  DEFAULT_QUEUE_TIMEOUT_SECONDS,
  findResourceGateBinary,
  isExecutableFile,
  isResourceGateBypassed,
  resolveResourceGateInvocation,
  worktreeGateSuffix,
} from "./resource-gate.mjs";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resource-gate shared helper", () => {
  it("exports default queue and execution timeouts", () => {
    expect(DEFAULT_QUEUE_TIMEOUT_SECONDS).toBe(300);
    expect(DEFAULT_EXECUTION_TIMEOUT_SECONDS).toBe(900);
  });

  it("checks executable regular files and rejects directories, non-executables, and missing paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "openlup-resource-gate-"));
    tempDirs.push(dir);
    const execPath = join(dir, "ai-resource-gate");
    const nonExecPath = join(dir, "plain.txt");
    const subDir = join(dir, "subdir");
    writeFileSync(execPath, "#!/bin/sh\nexit 0\n");
    chmodSync(execPath, 0o755);
    writeFileSync(nonExecPath, "plain\n");
    chmodSync(nonExecPath, 0o644);
    mkdirSync(subDir, { mode: 0o755 });

    expect(isExecutableFile(execPath)).toBe(true);
    expect(isExecutableFile(nonExecPath)).toBe(false);
    expect(isExecutableFile(subDir)).toBe(false);
    expect(isExecutableFile(join(dir, "missing"))).toBe(false);
  });

  it("finds ai-resource-gate on PATH and returns null when absent", () => {
    const env = { PATH: ["/first/bin", "", "/second/bin"].join(delimiter) };
    expect(
      findResourceGateBinary(env, candidate => candidate === join("/second/bin", "ai-resource-gate")),
    ).toBe(join("/second/bin", "ai-resource-gate"));
    expect(findResourceGateBinary(env, () => false)).toBeNull();
    expect(findResourceGateBinary({}, () => true)).toBeNull();
  });

  it("produces deterministic decimal uint64 worktree suffixes scoped to resolved paths", () => {
    const suffixA = worktreeGateSuffix("/tmp/openlup-wt-a");
    const suffixANormalized = worktreeGateSuffix("/tmp/openlup-wt-a/sub/..");
    const suffixB = worktreeGateSuffix("/tmp/openlup-wt-b");
    expect(suffixA).toMatch(/^\d+$/u);
    expect(suffixA).toBe(suffixANormalized);
    expect(suffixB).not.toBe(suffixA);
  });

  it("detects CI, nested-gate, and opt-out bypass flags", () => {
    expect(isResourceGateBypassed({})).toBe(false);
    expect(isResourceGateBypassed({ CI: "false", AI_RESOURCE_GATE_ACTIVE: "0", OPENLUP_DISABLE_RESOURCE_GATE: "0" })).toBe(false);
    expect(isResourceGateBypassed({ CI: "true" })).toBe(true);
    expect(isResourceGateBypassed({ AI_RESOURCE_GATE_ACTIVE: "1" })).toBe(true);
    expect(isResourceGateBypassed({ OPENLUP_DISABLE_RESOURCE_GATE: "1" })).toBe(true);
  });

  it("builds gated invocations with default timeouts, optional lane, and custom or omitted timeouts", () => {
    const broker = join("/custom/bin", "ai-resource-gate");
    const env = { PATH: "/custom/bin" };
    const hit = (candidate: string) => candidate === broker;

    const standard = resolveResourceGateInvocation({
      cwd: "/tmp/wt-1",
      profile: "openlup:landing-build",
      command: "/usr/bin/node",
      args: ["npm-cli.js", "ci"],
      env,
      checkExecutable: hit,
    });
    const expectedKey = `openlup:landing-build:wt${worktreeGateSuffix("/tmp/wt-1")}`;
    expect(standard).toEqual({
      command: broker,
      args: [
        "run",
        "--wait",
        "--queue-timeout",
        "300",
        "--execution-timeout",
        "900",
        expectedKey,
        "--",
        "/usr/bin/node",
        "npm-cli.js",
        "ci",
      ],
      key: expectedKey,
    });

    const withLaneAndCustomTimeouts = resolveResourceGateInvocation({
      cwd: "/tmp/wt-1",
      profile: "openlup:inventory-refresh",
      lane: "docker-heavy",
      queueTimeout: 120,
      executionTimeout: 600,
      command: "/usr/bin/node",
      args: ["--import", "tsx", "scripts/installation-inventory-refresh.ts"],
      env,
      checkExecutable: hit,
    });
    expect(withLaneAndCustomTimeouts?.args).toEqual([
      "run",
      "--wait",
      "--lane",
      "docker-heavy",
      "--queue-timeout",
      "120",
      "--execution-timeout",
      "600",
      `openlup:inventory-refresh:wt${worktreeGateSuffix("/tmp/wt-1")}`,
      "--",
      "/usr/bin/node",
      "--import",
      "tsx",
      "scripts/installation-inventory-refresh.ts",
    ]);

    const withoutTimeouts = resolveResourceGateInvocation({
      cwd: "/tmp/wt-1",
      profile: "openlup:build",
      queueTimeout: null,
      executionTimeout: null,
      command: "stub",
      env,
      checkExecutable: hit,
    });
    expect(withoutTimeouts?.args).toEqual([
      "run",
      "--wait",
      `openlup:build:wt${worktreeGateSuffix("/tmp/wt-1")}`,
      "--",
      "stub",
    ]);
  });

  it("handles bypasses, PATH fallback, and requireBroker semantics", () => {
    const broker = join("/custom/bin", "ai-resource-gate");
    const env = { PATH: "/custom/bin" };
    const hit = (candidate: string) => candidate === broker;

    expect(resolveResourceGateInvocation({ cwd: "/tmp/wt-1", profile: "openlup:build", command: "stub", env: { ...env, CI: "true" }, checkExecutable: hit })).toBeNull();
    expect(resolveResourceGateInvocation({ cwd: "/tmp/wt-1", profile: "openlup:build", command: "stub", env: { ...env, AI_RESOURCE_GATE_ACTIVE: "1" }, checkExecutable: hit })).toBeNull();
    expect(resolveResourceGateInvocation({ cwd: "/tmp/wt-1", profile: "openlup:build", command: "stub", env: { ...env, OPENLUP_DISABLE_RESOURCE_GATE: "1" }, checkExecutable: hit })).toBeNull();
    expect(resolveResourceGateInvocation({ cwd: "/tmp/wt-1", profile: "openlup:build", command: "stub", env, checkExecutable: () => false })).toBeNull();

    expect(() =>
      resolveResourceGateInvocation({
        cwd: "/tmp/wt-1",
        profile: "openlup:build",
        command: "stub",
        env,
        checkExecutable: () => false,
        requireBroker: true,
      }),
    ).toThrow("ai-resource-gate is unavailable");

    const requiredInCi = resolveResourceGateInvocation({
      cwd: "/tmp/wt-1",
      profile: "openlup:build",
      command: "stub",
      env: { ...env, CI: "true" },
      checkExecutable: hit,
      requireBroker: true,
    });
    expect(requiredInCi?.command).toBe(broker);
  });

  it("refuses invalid resource profiles", () => {
    const env = { PATH: "/custom/bin" };
    const hit = () => true;
    for (const invalid of ["", "Openlup:build", "0bad", "bad profile", "bad_profile", "a".repeat(129)]) {
      expect(() =>
        resolveResourceGateInvocation({
          cwd: "/tmp/wt-1",
          profile: invalid,
          command: "stub",
          env,
          checkExecutable: hit,
        }),
      ).toThrow("resource profile is invalid");
    }
  });
});
