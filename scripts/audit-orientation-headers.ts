/**
 * Header truth for the documents the index classifies at the top level: the canon header block
 * under the H1, the class it declares, its `Verified against <sha>` attestation, and the
 * language its prose is written in. Split out of `audit-orientation-docs.ts`, which owns the
 * other half - which documents exist and how the index classifies them.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  indexClassifications,
  topLevelDocs,
  type DocumentationIndexConfig,
  type Failure,
} from "./audit-orientation-docs.ts";
import {
  gitLines, introducedUnderReview, pathsUnderReview, resolveReviewBase, type ReviewBase,
} from "./git-review-scope.ts";

/** Classes whose documents claim to describe current state, so must read as documentation prose. */
const ACTIVE_CLASSES = new Set(["source-of-truth", "runbook", "generated", "plan-active"]);
/** A canon header is the `Key: value` block directly under the H1, before the first blank line. */
const HEADER_FIELD = /^\*{0,2}([A-Z][A-Za-z ]{1,24})\*{0,2}:\s*(.*)$/;
const ATTESTATION = /Verified against `([0-9a-f]{7,40})`(?:[^\n]*?\((\d{4}-\d{2}-\d{2})\))?/g;
const DIACRITIC = /[ąćęłńóśźżĄĆĘŁŃÓŚŹŻ]/g;
/** A blockquote that opens a market-data region: a two-letter locale tag, then `market data`. */
const MARKET_DATA_MARKER = /^\s*>\s*\*{0,2}[A-Z]{2}\s+market data/;
/**
 * Both halves must trip. A document in another language carries hundreds of diacritics over a few
 * thousand characters; an English one carries a handful - a provider's legal name, a quoted UI
 * string, a loanword - and a two-line file can carry one and mean nothing.
 */
const LANGUAGE_MIN_COUNT = 25;
const LANGUAGE_MIN_PER_10K = 20;

/** The attestation is a sentence inside the header block, not a `Key: value` field. */
const ATTESTATION_LINE = /^\*{0,2}Verified against/;

/**
 * The `Key: value` block under the H1. A wrapped value continues on the following lines, but never
 * across the attestation: its scope prose backticks paths, commands and SHAs it merely cites, and
 * folding those into the field above it would make `Watches:` watch a path a sentence mentions, or
 * let `Known drifts:` answer a glob nobody wrote down. Both matter now that `docs-header-stale`
 * fails rather than reports.
 */
export function headerFields(markdown: string): Map<string, string> {
  const fields = new Map<string, string>();
  const lines = markdown.split(/\r?\n/);
  let index = 1;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  let key: string | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "") break;
    const field = HEADER_FIELD.exec(line);
    if (field) {
      key = field[1].trim();
      fields.set(key, field[2].trim());
    } else if (ATTESTATION_LINE.test(line)) key = null;
    else if (key) fields.set(key, `${fields.get(key)} ${line.trim()}`);
  }
  return fields;
}

/**
 * The machine-readable class a `Status:` line declares, or null when it declares only prose. A
 * header may qualify its class ("runbook for third-party prerequisites"), but the class must come
 * first, so the qualifier can never change what the line resolves to.
 */
export function declaredClass(status: string, allowedStatuses: string[]): string | null {
  const value = status.replace(/^\*+/, "").trim();
  for (const candidate of [...allowedStatuses].sort((a, b) => b.length - a.length)) {
    if (!value.startsWith(candidate)) continue;
    const rest = value.slice(candidate.length);
    if (rest === "" || /^[\s.,;:(]/.test(rest)) return candidate;
  }
  return null;
}

/**
 * The document's own prose, with the regions its conventions mark as data removed: fenced code, a
 * market-data region (marker line to the next heading or rule), inline code spans, and inline
 * quoted market text. A sentence that merely mentions market data does not open a region.
 */
export function documentationProse(markdown: string): string {
  const kept: string[] = [];
  let inMarketData = false;
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (MARKET_DATA_MARKER.test(line)) {
      inMarketData = true;
      continue;
    }
    if (inMarketData && (/^#{1,6}\s/.test(line) || /^---\s*$/.test(line))) inMarketData = false;
    if (!inMarketData) kept.push(line);
  }
  return kept.join("\n").replace(/`[^`]*`/g, "").replace(/„[^"”]*["”]/g, "");
}

export function missingHeaderDocs(root: string, config: DocumentationIndexConfig): string[] {
  return topLevelDocs(root, config.directory).filter(
    (name) => !headerFields(readFileSync(join(root, config.directory, name), "utf8")).has("Status"),
  );
}

function git(root: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function auditAttestation(root: string, relPath: string, markdown: string, today: string): Failure[] {
  const failures: Failure[] = [];
  for (const [, sha, date] of markdown.matchAll(ATTESTATION)) {
    if (git(root, ["cat-file", "-e", `${sha}^{commit}`]) === null) {
      failures.push({ id: "docs-header-attestation", message: `${relPath} attests against unknown commit ${sha}` });
      continue;
    }
    if (git(root, ["merge-base", "--is-ancestor", sha, "HEAD"]) === null) {
      failures.push({ id: "docs-header-attestation", message: `${relPath} attests against ${sha}, which is not an ancestor of HEAD` });
      continue;
    }
    const committed = git(root, ["log", "-1", "--format=%cs", sha]);
    if (!date || !committed) continue;
    // `today` is UTC while an attestation date is written in the author's local calendar, so a
    // date one day ahead of UTC is a timezone, not a claim about the future.
    if (date < committed || date > today) {
      failures.push({
        id: "docs-header-attestation",
        message: `${relPath} attestation date ${date} is outside [${committed}, ${today}] for ${sha}`,
      });
    }
  }
  return failures;
}

/**
 * The ref that makes a staleness failure attributable: `base..HEAD` is the change under review, so
 * only the commits being proposed can fail. An explicit override wins - `--base <ref>`, or
 * `ORIENTATION_STALE_BASE` for a caller that cannot pass arguments - and otherwise the merge base
 * with `origin/main`. A base that does not resolve attributes nothing. A base equal to `HEAD`
 * attributes nothing only for a clean checkout: staged, unstaged, and untracked work is still the
 * proposal under review and must not disappear merely because it has not created a commit yet.
 */
export const resolveStaleBase = resolveReviewBase;

/** The globs a backticked header field names, in order. */
function backtickedGlobs(value: string | undefined): string[] {
  return value ? [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]) : [];
}

/**
 * `git log`, keeping the distinction `git()` throws away: "ran and found nothing" is not "could
 * not run". A malformed pathspec in `Watches:` makes git exit non-zero, and reading that as "no
 * drift" would exempt the document from this gate silently and permanently. It cannot wedge
 * `main`: only a change that edits the line can introduce one, and that change is what fails.
 */
type GitLog = { commits: string[]; error: string | null };

function gitLog(root: string, args: string[]): GitLog {
  const result = gitLines(root, args);
  return { commits: result.lines, error: result.error };
}

/**
 * The `document#glob` pairs the wave plans THIS CHANGE writes answer with `attested_watchers:`.
 *
 * Only plans changed under review are read, so a plan already sitting on `main` can never
 * discharge an obligation the change under review introduced, and an answer expires with the branch
 * that wrote it. That makes this a NARROWER escape than `Known drifts:`, which is written into the
 * document and silences its glob for every future change.
 *
 * The field is read out of section 2 only - the same region `read_plan_metadata` in
 * `scripts/validate-wave-plan.sh` validates - so the key this honours and the key Plan Protocol
 * checks are one key in one place. `#` separates the pair, so unlike every other section-2 key a
 * trailing `# comment` is NOT stripped: it would eat the glob. Git failing here answers nothing,
 * which leaves the gate exactly as hard as it is without this path.
 */
function planAnsweredWatchers(root: string, base: ReviewBase, planDirectory: string): Set<string> {
  const answered = new Set<string>();
  if (base.ref === null) return answered;
  const changed = pathsUnderReview(root, base, [planDirectory]);
  if (changed.error) return answered;
  for (const plan of changed.paths) {
    let lines: string[];
    try {
      lines = readFileSync(join(root, plan), "utf8").split(/\r?\n/);
    } catch {
      continue; // The change deleted or renamed it; a plan that is not in this tree answers nothing.
    }
    const opens = lines.findIndex((line) => /^## 2\./.test(line));
    if (opens === -1) continue;
    for (const line of lines.slice(opens + 1)) {
      if (/^## /.test(line)) break;
      const field = /^attested_watchers:(.*)$/.exec(line);
      if (!field) continue;
      for (const entry of field[1].split(",")) {
        const pair = entry.trim();
        if (pair.includes("#")) answered.add(pair);
      }
    }
  }
  return answered;
}

/**
 * Staleness for one document. `Known drifts:` is SCOPED: it answers exactly the globs it names, so
 * a document that records one real drift keeps the gate over every other path it watches. Drift a
 * branch merely inherited from `main` stays a report; drift the change under review introduced
 * into a document it does not touch is a failure its author can always discharge - by touching the
 * document, or by naming that one `document#glob` pair in this branch's own wave plan.
 */
function watchStaleness(
  root: string,
  relPath: string,
  markdown: string,
  base: ReviewBase,
  planAnswers: Set<string>,
): { failures: Failure[]; reports: string[] } {
  const fields = headerFields(markdown);
  const sha = /Verified against `([0-9a-f]{7,40})`/.exec(markdown)?.[1];
  const answered = new Set(backtickedGlobs(fields.get("Known drifts")));
  const globs = backtickedGlobs(fields.get("Watches")).filter((glob) => !answered.has(glob));
  if (!sha || globs.length === 0) return { failures: [], reports: [] };

  const unreadable = (error: string) => ({
    failures: [{ id: "docs-header-watch-unreadable", message: `${relPath}: git cannot read this document's watched paths, so its staleness proves nothing - ${error}` }],
    reports: [],
  });

  if (base.ref !== null) {
    const introduced = pathsUnderReview(root, base, globs);
    if (introduced.error) return unreadable(introduced.error);
    if (introduced.paths.length > 0) {
      const document = pathsUnderReview(root, base, [relPath]);
      if (document.error) return unreadable(document.error);
      if (document.paths.length === 0) {
        // A plan answer is scoped exactly as `Known drifts:` is - to the one pair it spells out - so
        // the globs it does not name are re-measured on their own. Answering one glob can never mute
        // another the same change drifted, and the message names only what is still outstanding.
        const outstanding = globs.filter((glob) => !planAnswers.has(`${relPath}#${glob}`));
        if (outstanding.length > 0) {
          const drifted = outstanding.length === globs.length
            ? introduced
            : pathsUnderReview(root, base, outstanding);
          if (drifted.error) return unreadable(drifted.error);
          if (drifted.paths.length > 0) {
            const message = `${relPath}: ${drifted.paths.length} path(s) under review touched watched paths (${outstanding.join(", ")}) without touching the document - re-attest it, correct it, name the glob under 'Known drifts:', or answer the drifted glob in this branch's wave plan as 'attested_watchers: ${relPath}#<glob>'`;
            return { failures: [{ id: "docs-header-stale", message }], reports: [] };
          }
        }
      }
    }
  }

  const changed = gitLog(root, ["log", "--oneline", `${sha}..HEAD`, "--", ...globs]);
  if (changed.error) return unreadable(changed.error);
  if (changed.commits.length === 0) return { failures: [], reports: [] };
  return {
    failures: [],
    reports: [`docs-header-stale ${relPath}: ${changed.commits.length} commit(s) touched watched paths since ${sha} and no 'Known drifts:' entry answers them`],
  };
}

/**
 * Header truth for top-level documents.
 *
 * `docs-header-stale` is a FAILURE only for drift the change under review introduced: a watched
 * path changed in the committed/index/worktree proposal, the document was not touched there, and
 * no wave plan this change writes answers that exact `document#glob` pair - see
 * `planAnsweredWatchers`. Inherited drift,
 * measured from the attested SHA, stays a report, because a watched path can change without
 * invalidating the sentence a document attests to and nobody on this branch caused it; a plan
 * answer does not touch that report, so real staleness stays visible either way. When no base
 * resolves nothing is attributable and nothing fails - see `resolveStaleBase`. A watch list git
 * cannot read is a separate, unconditional failure (`docs-header-watch-unreadable`): it proves
 * nothing.
 *
 * `docs-header-attestation` is attributable too, in the opposite direction: an attestation is a
 * claim the document carries, so it fails for a document this change touches and reports for one it
 * does not - the commit a header attests against stops being an ancestor the moment its branch is
 * squashed in, and the whole-tree rule then failed whoever queued behind that author. Where nothing
 * is attributable it keeps failing: see `introducedUnderReview`.
 */
export function auditDocumentHeaders(
  root: string,
  config: DocumentationIndexConfig,
  options: { staleBase?: string } = {},
): { failures: Failure[]; reports: string[] } {
  const failures: Failure[] = [];
  const reports: string[] = [];
  const { classifications } = indexClassifications(root, config);
  const today = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
  const shallow = git(root, ["rev-parse", "--is-shallow-repository"]) !== "false";
  if (shallow) reports.push("attestation and staleness skipped: this checkout has no full history");
  const base: ReviewBase = shallow
    ? { ref: null, reason: "the checkout has no full history" }
    : resolveStaleBase(root, options.staleBase);
  if (!shallow && base.ref === null) {
    reports.push(`docs-header-stale cannot attribute drift on this checkout, so it can only report: ${base.reason}`);
    reports.push(`docs-header-attestation cannot attribute here, so it stays whole-tree and blocking: ${base.reason}`);
  }
  // `plan_dir` in `.agent-protocol.yml`, which is the index directory's own `plan/`. If it ever
  // moves, no plan is read and this gate simply stays as hard as it was before this path existed.
  const planAnswers = shallow ? new Set<string>() : planAnsweredWatchers(root, base, `${config.directory}/plan`);

  for (const name of topLevelDocs(root, config.directory)) {
    const relPath = `${config.directory}/${name}`;
    const markdown = readFileSync(join(root, relPath), "utf8");
    const fields = headerFields(markdown);
    const indexed = classifications.get(name);
    const status = fields.get("Status");

    if (status && indexed) {
      const declared = declaredClass(status, config.allowedStatuses);
      if (declared && declared !== indexed.status) {
        failures.push({
          id: "docs-header-class-mismatch",
          message: `${relPath} header declares '${declared}' but ${config.file} classifies it '${indexed.status}'`,
        });
      }
    }
    if ((fields.get("Consumed") ?? "").toLowerCase() === "yes") {
      failures.push({ id: "docs-oneshot-unarchived", message: `${relPath} is consumed and must be moved under ${config.directory}/archive/` });
    }
    if (!shallow) {
      // The verdict reads one file, so one path decides whose change it is.
      const attestation = auditAttestation(root, relPath, markdown, today);
      const inherited = attestation.length > 0 && !introducedUnderReview(root, base, [relPath]);
      if (inherited) reports.push(...attestation.map((failure) => `${failure.id} ${failure.message} - inherited from the base, and the change under review does not touch this document`));
      else failures.push(...attestation);
      const stale = watchStaleness(root, relPath, markdown, base, planAnswers);
      failures.push(...stale.failures);
      reports.push(...stale.reports);
    }

    if (!indexed || !ACTIVE_CLASSES.has(indexed.status)) continue;
    const prose = documentationProse(markdown);
    const count = (prose.match(DIACRITIC) ?? []).length;
    const per10k = prose.length === 0 ? 0 : (count / prose.length) * 10000;
    if (count >= LANGUAGE_MIN_COUNT && per10k >= LANGUAGE_MIN_PER_10K) {
      failures.push({
        id: "docs-header-language",
        message: `${relPath} is classified '${indexed.status}' but reads as non-English prose (${count} diacritics, ${per10k.toFixed(1)} per 10k characters)`,
      });
    }
  }
  return { failures, reports };
}
