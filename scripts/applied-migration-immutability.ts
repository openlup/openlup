import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const MANAGED_MIGRATION = /^supabase\/migrations\/\d{14}_[A-Za-z0-9_-]+\.sql$/;

export type MigrationChanges = {
  files: readonly string[];
  deleted: readonly string[];
};

export type AppliedMigrationCandidate = {
  file: string;
  appliedContent: string;
  candidateContent: string | null;
};

export function evaluateAppliedMigrationImmutability(
  migrations: readonly AppliedMigrationCandidate[],
  marker = "staging-deployed",
): string[] {
  return migrations.flatMap(({ file, appliedContent, candidateContent }) => {
    if (candidateContent === appliedContent) return [];
    const action = candidateContent === null ? "deletes" : "rewrites";
    return [
      `${file}: candidate ${action} migration bytes already present at ${marker}; ` +
      "restore the applied bytes exactly and ship the correction in a new forward migration",
    ];
  });
}

export function appliedMigrationMutationErrors(
  changes: MigrationChanges,
  root = process.cwd(),
  marker = "staging-deployed",
): string[] {
  execFileSync("git", ["rev-parse", "--verify", `${marker}^{commit}`], {
    cwd: root,
    stdio: "ignore",
  });
  const candidates = [...new Set([...changes.files, ...changes.deleted])]
    .filter((file) => MANAGED_MIGRATION.test(file));
  const markerFiles = new Set(execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", marker, "--", "supabase/migrations/"],
    { cwd: root, encoding: "utf8" },
  ).split("\n").filter(Boolean));
  const applied = candidates.filter((file) => markerFiles.has(file)).map((file) => ({
    file,
    appliedContent: execFileSync("git", ["show", `${marker}:${file}`], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    }),
    candidateContent: existsSync(`${root}/${file}`) ? readFileSync(`${root}/${file}`, "utf8") : null,
  }));
  return evaluateAppliedMigrationImmutability(applied, marker);
}
