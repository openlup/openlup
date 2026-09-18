import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import { type Failure } from "./audit-orientation-docs.ts";
import { introducedUnderReview, type ReviewBase } from "./git-review-scope.ts";

export type SizeCap = { file: string; maxBytes: number; reason: string; planRef: string };

/** Where the caps live, and therefore one of the paths a cap verdict is computed from. */
const CAP_CONFIG = "config/orientation-truths.json";

/** No base was passed, so nothing is attributable and every cap verdict keeps blocking. */
const UNATTRIBUTABLE: ReviewBase = { ref: null, reason: "no comparison base was passed to the size-cap audit" };

const MINIMUM_CAP_REASON_LENGTH = 20;

const CAP_REASON_PLACEHOLDER = /^(n\/?a|none|tbd|pending|placeholder|todo)\b/i;

/**
 * Reads the caps as they stand at the merge base, so a raise can be told from a fall. `null` means
 * the comparison could not be made - shallow clone, missing `origin/main`, or no config there yet -
 * and is reported rather than read as "nothing was pinned".
 */
export function capsAtMergeBase(root: string, baseRef?: string | null): Map<string, SizeCap> | null {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      return null;
    }
  };
  // The caller's resolved review base wins when it has one, so the raise comparison and the
  // attribution below read the same commit - including a merge-group base the queue names and
  // `git merge-base` cannot find, because the group ref is not on `main` yet.
  const base = baseRef ?? git(["merge-base", "origin/main", "HEAD"])?.trim();
  const source = base ? git(["show", `${base}:config/orientation-truths.json`]) : null;
  if (source === null) return null;
  try {
    return new Map(((JSON.parse(source) as { sizeCaps?: SizeCap[] }).sizeCaps ?? []).map((cap) => [cap.file, cap]));
  } catch {
    return null;
  }
}

/**
 * One cap's verdict, unattributed: every failure it can produce, plus the headroom line it prints
 * when there is nothing to fail. Separated from the loop so the attribution below sees every
 * verdict - a cap that exits early because its file is missing must still reach it.
 */
function auditOneCap(
  root: string,
  cap: SizeCap,
  pinned: Map<string, SizeCap> | null,
  reports: string[],
): Failure[] {
  const failures: Failure[] = [];
  const fail = (message: string) => failures.push({ id: "size-cap", message });
  const capped = join(root, cap.file);
  if (!existsSync(capped)) {
    fail(`Missing capped file: ${cap.file}`);
    return failures;
  }

  const actual = statSync(capped).size;
  if (actual > cap.maxBytes) {
    fail(
      `${cap.file} is ${actual} B, over its ${cap.maxBytes} B cap by ${actual - cap.maxBytes} B. Evict a rule in ` +
        "this change, or raise the cap in config/orientation-truths.json with a reason written for this raise " +
        "and a plan reference.",
    );
  } else {
    reports.push(`${cap.file}: ${actual}/${cap.maxBytes} B, ${cap.maxBytes - actual} B before an addition costs a removal`);
  }

  const reason = cap.reason?.trim() ?? "";
  if (reason.length < MINIMUM_CAP_REASON_LENGTH || CAP_REASON_PLACEHOLDER.test(reason)) {
    fail(`${cap.file} cap carries no written reason`);
  }
  if (!cap.planRef || !existsSync(join(root, cap.planRef))) {
    fail(`${cap.file} cap names a plan reference that does not exist: ${cap.planRef ?? ""}`);
  }

  const before = pinned?.get(cap.file);
  if (before && cap.maxBytes > before.maxBytes && reason === before.reason?.trim()) {
    fail(
      `${cap.file} cap rises from ${before.maxBytes} to ${cap.maxBytes} B carrying the reason already present at ` +
        "the merge base; a raise needs a reason written for it.",
    );
  }
  return failures;
}

/**
 * Codex concatenates `~/.codex/AGENTS.md` with this repository's instruction file and truncates the
 * chain at `project_doc_max_bytes` - 32768 by default - with no warning in any interface. The
 * repository file is concatenated last, so what disappears is its tail, and the newest section dies
 * first.
 *
 * The cliff is growth, not size: `AGENTS.md` went from 24 lines to 390 in 99 days and its history
 * holds no commit whose purpose was to remove a rule - the one that moved three rules out to an
 * editor hook still added 30 lines describing it. A ceiling removes the cliff without deleting
 * anything.
 *
 * Shrink-only like `legacyLargeFileCaps`: a cap may fall or stay freely, and may rise only behind a
 * reason written for that raise, because a reason already present at the merge base is a copy
 * rather than a decision. Full argument: docs/plan/agents-md-shrink-only-cap.md.
 *
 * `pinned` is passed in rather than read here so the judgement stays a pure function of two
 * inputs: the tree as it is, and the caps as they were. Only `capsAtMergeBase` touches git.
 */
export function auditSizeCaps(
  root: string,
  caps: readonly SizeCap[],
  pinned: Map<string, SizeCap> | null,
  base: ReviewBase = UNATTRIBUTABLE,
): { failures: Failure[]; reports: string[] } {
  const failures: Failure[] = [];
  const reports: string[] = [];

  for (const cap of caps) {
    const capFailures = auditOneCap(root, cap, pinned, reports);
    if (capFailures.length === 0) continue;

    // A cap verdict reads three things: the capped file, the cap entry, and the plan that entry
    // cites. A change that touched none of them inherited whatever this says, and a ceiling on the
    // whole tree that fails on inherited state evicts the next pull request in the queue rather
    // than the one that spent the headroom. Fails closed, exactly as the attestation rule does.
    const inputs = [cap.file, CAP_CONFIG, ...(cap.planRef ? [cap.planRef] : [])];
    if (introducedUnderReview(root, base, inputs)) {
      failures.push(...capFailures);
    } else {
      reports.push(
        ...capFailures.map(
          (failure) =>
            `${failure.id} ${failure.message} - inherited from the base, and the change under review touches none of ${inputs.join(", ")}`,
        ),
      );
    }
  }

  if (caps.length > 0 && pinned === null) {
    reports.push("size-cap merge-base comparison skipped: no reachable origin/main merge base, or no config there");
  }
  if (caps.length > 0 && base.ref === null) {
    reports.push(`size-cap cannot attribute on this checkout, so it stays whole-tree and blocking: ${base.reason}`);
  }
  return { failures, reports };
}
