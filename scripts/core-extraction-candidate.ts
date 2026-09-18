import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  assert,
  assertGitSha,
  defaultCommandRunner,
  errorText,
  isMissingCommand,
  runRequired,
  sanitizedGitEnvironment,
  type CommandRunner,
} from "./core-extraction-command.ts";

export type IsolatedSubtreeCandidate = {
  candidateRoot: string;
  subtreeSha: string;
  historyCommitCount: number;
};

function assertSafeRef(sourceRef: string): void {
  assert(sourceRef.length > 0, "source ref must not be empty");
  assert(!sourceRef.startsWith("-"), "source ref must not start with '-'");
  assert(
    !/[\0-\x20\x7f]/.test(sourceRef),
    "source ref must not contain whitespace or control characters",
  );
}

export function resolveSourceCommit(
  repoRoot: string,
  sourceRef: string,
  runner: CommandRunner = defaultCommandRunner,
): string {
  assertSafeRef(sourceRef);
  const output = runRequired(
    "resolve source ref",
    "git",
    ["rev-parse", "--verify", "--end-of-options", `${sourceRef}^{commit}`],
    repoRoot,
    runner,
    sanitizedGitEnvironment(),
  );
  return assertGitSha(output, "git rev-parse");
}

export function assertCandidateRefIsolation(refs: string[]): void {
  const normalized = refs.map((ref) => ref.trim()).filter(Boolean).sort();
  assert(
    normalized.length === 1 && normalized[0] === "refs/heads/main",
    `isolated candidate must contain only refs/heads/main; found: ${normalized.join(", ") || "<none>"}`,
  );
}

function assertNoObjectAlternates(candidateRoot: string): void {
  const alternates = join(candidateRoot, ".git", "objects", "info", "alternates");
  assert(
    !existsSync(alternates),
    `isolated candidate must not borrow objects through ${alternates}`,
  );
}

export function createIsolatedSubtreeCandidate(options: {
  repoRoot: string;
  sourceSha: string;
  tempRoot: string;
  runner: CommandRunner;
}): IsolatedSubtreeCandidate {
  const bareRoot = join(options.tempRoot, "candidate.git");
  const candidateRoot = join(options.tempRoot, "candidate");
  const gitEnvironment = sanitizedGitEnvironment();
  const subtreeSha = assertGitSha(
    runRequired(
      "create package subtree history",
      "git",
      ["subtree", "split", "--quiet", "--prefix=packages/core", options.sourceSha],
      options.repoRoot,
      options.runner,
      gitEnvironment,
    ),
    "git subtree split",
  );

  runRequired(
    "initialize isolated bare repository",
    "git",
    ["init", "--bare", bareRoot],
    options.tempRoot,
    options.runner,
    gitEnvironment,
  );
  runRequired(
    "transfer subtree commit",
    "git",
    [
      "--git-dir",
      bareRoot,
      "fetch",
      "--no-tags",
      options.repoRoot,
      `${subtreeSha}:refs/heads/main`,
    ],
    options.tempRoot,
    options.runner,
    gitEnvironment,
  );
  runRequired(
    "clone isolated subtree candidate",
    "git",
    ["-c", "core.hooksPath=/dev/null", "clone", "--no-local", "--no-tags", "--single-branch", "--branch", "main", bareRoot, candidateRoot],
    options.tempRoot,
    options.runner,
    gitEnvironment,
  );
  runRequired(
    "remove candidate transport remote",
    "git",
    ["remote", "remove", "origin"],
    candidateRoot,
    options.runner,
    gitEnvironment,
  );

  const refs = runRequired(
    "enumerate candidate refs",
    "git",
    ["for-each-ref", "--format=%(refname)"],
    candidateRoot,
    options.runner,
    gitEnvironment,
  ).split(/\r?\n/);
  assertCandidateRefIsolation(refs);
  assertNoObjectAlternates(candidateRoot);
  assert(
    resolveSourceCommit(candidateRoot, "HEAD", options.runner) === subtreeSha,
    "isolated candidate HEAD does not match the subtree commit",
  );

  const historyCountText = runRequired(
    "count candidate full history",
    "git",
    ["rev-list", "--all", "--count"],
    candidateRoot,
    options.runner,
    gitEnvironment,
  ).trim();
  assert(
    /^\d+$/.test(historyCountText) && Number(historyCountText) > 0,
    `invalid candidate history count: ${historyCountText}`,
  );
  return { candidateRoot, subtreeSha, historyCommitCount: Number(historyCountText) };
}

export function sanitizedGitleaksEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const sanitized = { ...environment };
  delete sanitized.GITLEAKS_CONFIG;
  delete sanitized.GITLEAKS_CONFIG_TOML;
  return sanitized;
}

export function runCandidateHistoryGitleaks(
  candidateRoot: string,
  runner: CommandRunner = defaultCommandRunner,
  environment: NodeJS.ProcessEnv = process.env,
  policy: { configPath: string; ignorePath: string } = {
    configPath: join(candidateRoot, "..", "trusted-gitleaks.toml"),
    ignorePath: join(candidateRoot, "..", "trusted-gitleaks-ignore"),
  },
): "passed" | "skipped-unavailable" {
  const env = sanitizedGitleaksEnvironment(environment);
  try {
    runner("gitleaks", ["version"], { cwd: candidateRoot, env });
  } catch (error) {
    if (isMissingCommand(error) && environment.ALLOW_GITLEAKS_SKIP === "1") {
      return "skipped-unavailable";
    }
    if (isMissingCommand(error)) {
      throw new Error("gitleaks is required; set ALLOW_GITLEAKS_SKIP=1 only for an explicitly incomplete local rehearsal", { cause: error });
    }
    throw new Error(`gitleaks availability check failed: ${errorText(error)}`, { cause: error });
  }
  runRequired(
    "candidate-only full-history gitleaks scan",
    "gitleaks",
    [
      "git",
      ".",
      "--config",
      policy.configPath,
      "--gitleaks-ignore-path",
      policy.ignorePath,
      "--ignore-gitleaks-allow",
      "--redact",
      "--no-banner",
      "--log-opts=--all --full-history",
    ],
    candidateRoot,
    runner,
    env,
  );
  return "passed";
}
