// The SQL stage of the split rehearsal: the class BOTH other stages are blind to.
//
// The module stage compiles the published tree and the asset stage resolves asset specifiers in it.
// Neither one reads SQL. A migration the published tree KEEPS can call a serverless function the
// published tree DOES NOT CONTAIN, and every existing falsifier reports green while it does - which
// is exactly how this class survived to be found by hand during the F0 rehearsal.
//
// METHOD, and why it is not a URL pattern. The obvious scan - grep the literal path segment a
// function URL ends with - undercounts by construction, because the call site does not have to
// spell the URL. Four of the sites in this repository build the target by concatenating a base URL
// held in a VARIABLE with a suffix, and the base URL itself comes from a configuration row that no
// static reader can evaluate. This stage therefore resolves the target EXPRESSION: a literal is read
// directly, and an identifier is followed back to its assignment in the same routine. A measurement
// built on literals alone therefore undercounts whenever a scheduler keeps the base in configuration.
//
// The second ratchet has a different subject. A kept file may pin a specific deployment by spelling
// its host, which makes the published tree point at the publisher's own infrastructure. The detector
// is deliberately environment-neutral: it matches the SHAPE of an opaque project reference, not any
// particular project, so it catches an adopter's own pinned deployment exactly as it catches ours.
// It reads SQL and CONFIGURATION alike, because a reference configured in a .toml pins a deployment
// exactly as hard as one spelled in a migration - and reads bare references only outside SQL, where
// the shape is unambiguous.
//
// Both ratchets are exact and both are shrink-only. A count that FALLS fails too, because a scan
// that quietly stopped matching is indistinguishable from debt that was paid, and only the exact
// form makes the difference visible.

import { checkedHelperContracts, rejectingNamespaceGuard, rememberHelperSelection, type PendingGuard, type TargetProvenance } from "./oss-split-rehearsal-sql-provenance.ts";
export type { TargetProvenance } from "./oss-split-rehearsal-sql-provenance.ts";

/** `url := <expr>` inside a call, wherever the call sits: a schedule body, a routine, a trigger. */
const URL_ARGUMENT = /\burl\s*:=\s*(.+?)\s*,?\s*$/;
/** `v_name := <expr>;` - the assignment an identifier target is resolved against. */
const ASSIGNMENT = /^\s*(v_[a-z0-9_]+)\s*:=\s*(.+?);\s*$/i;
/** The trailing segment that names the function, in a literal or in a concatenation. */
const NAMED_SUFFIX = /\|\|\s*'\/([a-z0-9][a-z0-9-]*)'/i;
const NAMED_IN_LITERAL = /\/(functions\/v1|api\/cron)\/([a-z0-9][a-z0-9-]*)(?=['"),\s]|$)/i;
/** A routine boundary is also a data-flow boundary: local assignments cannot cross it. */
const ROUTINE_BOUNDARY = /^\s*(?:CREATE(?:\s+OR\s+REPLACE)?\s+(?:FUNCTION|PROCEDURE)\b|DO\s+\$[a-z0-9_]*\$|AS\s+\$[a-z0-9_]*\$|\$[a-z0-9_]*\$\s*;)/i;
/**
 * An opaque project host: a leftmost label of exactly twenty lowercase alphanumerics. That shape is
 * what a managed deployment identifier looks like; naming a vendor here would make the detector
 * describe one hosting product instead of the defect.
 */
const PINNED_HOST = /https:\/\/([a-z0-9]{20}\.[a-z0-9.-]*[a-z0-9])/gi;
/**
 * The same opaque twenty-character shape, spelled BARE in a configuration assignment instead of
 * inside a URL: `project_id = "…"`. Adding `.toml` to the file filter alone would have caught
 * nothing, because a configured reference carries neither the scheme nor the dot the URL detector
 * requires - which is precisely how a live deployment reference sat in a publishable family with no
 * ratchet on it. The key is matched by SHAPE too (a name ending in `id` or `ref`), so an adopter's
 * own configured project is caught by the same rule.
 */
const PINNED_PROJECT_REF = /^\s*[a-z0-9_.-]*(?:id|ref)\s*=\s*["']([a-z0-9]{20})["']/gi;
/** The entrypoint file every withheld function directory carries. */
const FUNCTION_ENTRYPOINT = "/index.ts";
/**
 * The sources both host measurements read. SQL is where the call-target class lives; configuration
 * carries no calls but pins deployments just as hard, and the two callers share this predicate so
 * they can never drift into two definitions of the same defect.
 */
export const isHostBearingSource = (path: string): boolean => path.endsWith(".sql") || path.endsWith(".toml");

export type SqlEdges = { calls: string[]; sites: number; hosts: string[]; hostSites: number };
export type SqlEdgePin = { enabled: boolean; calls?: number; callHashes?: string[]; hosts?: number; hostHashes?: string[] };
export type TargetVerdict =
  | { provenance: TargetProvenance; slug: string }
  | { provenance: "unknown"; diagnostic: string };
type Hash = (value: string) => string;

/**
 * Function names the published tree would NOT contain, derived from the catalog's own withholding
 * selectors and the tracked file list. Nothing about the layout is typed here: a directory that
 * moves between families moves this set with it, instead of stranding the measurement.
 */
export function withheldFunctions(withheld: string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const path of withheld) {
    if (!path.endsWith(FUNCTION_ENTRYPOINT)) continue;
    const directory = path.slice(0, -FUNCTION_ENTRYPOINT.length);
    const name = directory.slice(directory.lastIndexOf("/") + 1);
    if (name && !found.has(name)) found.set(name, directory);
  }
  return found;
}

/**
 * The assignment a target identifier resolves against is the NEAREST PRECEDING one, so the map is
 * built while walking the file rather than before it. In the chain each call site sits in its own
 * migration and the distinction never showed; in a flattened baseline every routine shares one file,
 * and resolving against the first assignment in that file silently collapses four distinct call
 * sites onto whichever function happens to be defined earliest.
 */
function literalBaseProvenance(expression: string): TargetProvenance | null {
  const literal = /^\s*'([^']*)'(?:::text)?\s*$/i.exec(expression);
  if (!literal) return null;
  if (/^https:\/\/[^/]+\/functions\/v1\/?$/i.test(literal[1])) return "edge-function";
  if (/^https:\/\/[^/]+\/api\/cron\/?$/i.test(literal[1])) return "application-cron";
  return null;
}

function rememberAssignment(
  line: string,
  known: Map<string, string[]>,
  namespaces: Map<string, TargetProvenance>,
): void {
  const match = ASSIGNMENT.exec(line);
  if (!match) return;
  known.set(match[1], [match[2]]);
  namespaces.delete(match[1]);
  const literal = literalBaseProvenance(match[2]);
  if (literal) namespaces.set(match[1], literal);
}

function namespaceFromLiteral(value: string): TargetProvenance {
  return value.toLowerCase() === "functions/v1" ? "edge-function" : "application-cron";
}

function resolvedTarget(
  expression: string,
  namespaces: Map<string, TargetProvenance>,
): TargetVerdict | null {
  const literalExpression = /^\s*'([^']*)'(?:::text)?\s*,?\s*$/i.exec(expression);
  const literal = literalExpression ? NAMED_IN_LITERAL.exec(literalExpression[1]) : null;
  if (literal) return { provenance: namespaceFromLiteral(literal[1]), slug: literal[2] };
  const inline = NAMED_SUFFIX.exec(expression);
  if (!inline) return null;
  const base = /^\s*([a-z0-9_]+)\s*\|\|/i.exec(expression);
  if (!base) return { provenance: "unknown", diagnostic: "the target suffix has no provable namespace base" };
  const provenance = namespaces.get(base[1]);
  if (!provenance) {
    return { provenance: "unknown", diagnostic: `the namespace of ${base[1]} is not proven` };
  }
  return { provenance, slug: inline[1] };
}

/** The function a target expression names, resolving one level of variable indirection. */
export function targetFunction(
  expression: string,
  known: Map<string, string[]>,
  namespaces: Map<string, TargetProvenance> = new Map(),
): TargetVerdict {
  const direct = resolvedTarget(expression, namespaces);
  if (direct) return direct;
  const identifier = /^\(*\s*([a-z0-9_]+)\b/i.exec(expression);
  if (!identifier) return { provenance: "unknown", diagnostic: "the target expression has no resolvable identifier" };
  for (const assigned of known.get(identifier[1]) ?? []) {
    const resolved = resolvedTarget(assigned, namespaces);
    if (resolved) return resolved;
  }
  return { provenance: "unknown", diagnostic: `the nearest assignment of ${identifier[1]} does not prove a target namespace` };
}

/**
 * Calls into withheld functions, and pinned hosts, measured over the SQL the published tree keeps.
 *
 * `keptSql` is the kept `.sql` inventory, `withheld` the withheld inventory, and `read` returns a
 * kept file's text. All three are injected so this is testable without a tree on disk.
 */
export function sqlEdges(keptSql: string[], withheld: string[], read: (path: string) => string): SqlEdges {
  const { edges, targets } = scanSql(keptSql, withheld, read);
  // Two ways this extraction dies silently, both fatal rather than green: no call site at all, and
  // any call site whose namespace cannot be proven (including a rewritten assignment form).
  if (edges.sites === 0) throw new Error("the SQL stage found no outbound call target in the kept tree; the extraction is dead");
  if (targets === 0) throw new Error(`the SQL stage proved none of ${edges.sites} call target(s); the resolver is dead`);
  return edges;
}

/**
 * The same two measurements over a tree where ABSENCE is the expected result - the publication tree
 * the split manifest composes, where the chain has been replaced by a flattened baseline. The
 * liveness guards above would turn that success into a throw, so they belong to the caller that
 * measures debt, not to the one that measures its removal. The scan itself is shared, so the two
 * callers can never drift into two different definitions of the same edge.
 */
export function scanSql(
  keptSql: string[],
  withheld: string[],
  read: (path: string) => string,
): { edges: SqlEdges; targets: number } {
  const functions = withheldFunctions(withheld);
  // A withheld inventory that yields no function directory would make every call site look resolved.
  if (functions.size === 0) throw new Error("the SQL stage found no withheld function directory; the partition is dead");
  const calls = new Set<string>();
  const hosts = new Set<string>();
  let sites = 0;
  let targets = 0;
  let hostSites = 0;
  const unknowns: string[] = [];
  for (const path of keptSql) {
    const source = read(path);
    const lines = source.split("\n");
    const helpers = checkedHelperContracts(source);
    const known = new Map<string, string[]>();
    const namespaces = new Map<string, TargetProvenance>();
    let pendingGuard: PendingGuard | null = null;
    for (const [lineIndex, line] of lines.entries()) {
      for (const [, host] of line.matchAll(PINNED_HOST)) {
        hostSites += 1;
        hosts.add(`${path} -> ${host}`);
      }
      // The bare form is read only outside SQL: a twenty-character opaque token assigned to an
      // `…id`/`…ref` key is a deployment reference in configuration, while in SQL the same shape is
      // indistinguishable from an ordinary generated identifier and would manufacture findings.
      if (!path.endsWith(".sql")) {
        for (const [, reference] of line.matchAll(PINNED_PROJECT_REF)) {
          hostSites += 1;
          hosts.add(`${path} -> ${reference}`);
        }
      }
      if (line.trim().startsWith("--")) continue;

      if (ROUTINE_BOUNDARY.test(line)) {
        known.clear();
        namespaces.clear();
        pendingGuard = null;
        continue;
      }

      if (pendingGuard) {
        if (/^\s*IF\b.+\bTHEN\s*$/i.test(line)) { pendingGuard.depth += 1; pendingGuard.invalid = true; }
        else if (/^\s*END\s+IF\s*;/i.test(line)) {
          pendingGuard.depth -= 1;
          if (pendingGuard.depth === 0) {
            if (pendingGuard.rejects && !pendingGuard.invalid) {
              namespaces.set(pendingGuard.variable, pendingGuard.provenance);
            }
            pendingGuard = null;
          }
        } else if (pendingGuard.depth === 1 && /^\s*RAISE\s+EXCEPTION\b.+;\s*$/i.test(line)) pendingGuard.rejects = true;
        else if (line.trim() !== "") pendingGuard.invalid = true;
      } else {
        const guard = rejectingNamespaceGuard(line);
        if (guard) pendingGuard = { ...guard, depth: 1, rejects: false, invalid: false };
      }

      rememberHelperSelection(line, helpers, known, namespaces);
      rememberAssignment(line, known, namespaces);
      const argument = URL_ARGUMENT.exec(line);
      if (!argument) continue;
      sites += 1;
      const target = targetFunction(argument[1], known, namespaces);
      if (target.provenance === "unknown") {
        unknowns.push(`${path}:${lineIndex + 1}: ${target.diagnostic}`);
        continue;
      }
      targets += 1;
      if (target.provenance !== "edge-function") continue;
      if (functions.has(target.slug)) calls.add(`${path} -> ${functions.get(target.slug)}`);
    }
  }
  if (unknowns.length > 0) {
    throw new Error(`the SQL stage found ${unknowns.length} outbound target(s) with unknown provenance:\n${unknowns.map((entry) => `  ${entry}`).join("\n")}`);
  }
  return { edges: { calls: [...calls].sort(), sites, hosts: [...hosts].sort(), hostSites }, targets };
}

/**
 * One exact ratchet, both directions. A new entry is a regression and is NAMED; a missing one is
 * either debt that was paid or a scan that died, and both need a human to lower the pin.
 */
function exactRatchet(label: string, measured: string[], pinnedHashes: string[], pinnedCount: number, hash: Hash, lines: string[]): boolean {
  const pinned = new Set(pinnedHashes);
  const introduced = measured.filter((entry) => !pinned.has(hash(entry)));
  const seen = new Set(measured.map(hash));
  const paid = pinnedHashes.filter((entry) => !seen.has(entry)).length;
  if (introduced.length > 0) lines.push(`${introduced.length} ${label} the pin does not carry:`, ...introduced.map((entry) => `  + ${entry}`));
  if (paid > 0) {
    lines.push(`${paid} pinned ${label} are gone: measured ${measured.length} against pin ${pinnedCount}.`);
    lines.push(`  lower the pin with: npm run oss:split-rehearsal -- --write-baseline`);
  }
  return introduced.length > 0 || paid > 0;
}

/** Both SQL ratchets against the pin. True when either moved, in either direction. */
export function compareSqlEdge(measured: SqlEdges, pin: SqlEdgePin, hash: Hash, lines: string[]): boolean {
  const calls = exactRatchet("SQL call(s) into a withheld function", measured.calls, pin.callHashes ?? [], pin.calls ?? 0, hash, lines);
  const hosts = exactRatchet("pinned deployment reference(s) in the kept tree", measured.hosts, pin.hostHashes ?? [], pin.hosts ?? 0, hash, lines);
  return calls || hosts;
}

/** This stage's section of the written pin. The stage owns its own shape, as the asset stage does not yet. */
export function sqlEdgePin(measured: SqlEdges, hash: Hash, digest: (hashes: string[]) => string): Record<string, unknown> {
  return {
    enabled: true,
    mode: "exact-ratchet",
    method: "Target-expression resolution, not a URL pattern: a call site may build its target from a variable whose value no static reader can evaluate, so a literal-only scan undercounts. The host detector matches the SHAPE of an opaque project reference - inside a URL anywhere, and bare in a configuration assignment outside SQL - so it catches an adopter's pinned deployment as readily as ours.",
    sites: measured.sites,
    calls: measured.calls.length,
    callDigest: digest(measured.calls.map(hash)),
    callHashes: measured.calls.map(hash).sort(),
    hostSites: measured.hostSites,
    hosts: measured.hosts.length,
    hostDigest: digest(measured.hosts.map(hash)),
    hostHashes: measured.hosts.map(hash).sort(),
  };
}
