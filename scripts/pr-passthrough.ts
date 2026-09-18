/**
 * Which argv tokens the PR wrapper may hand to `gh`.
 *
 * The wrapper and `gh` read overlapping but not identical flag sets. Forwarding argv
 * verbatim turns a green preflight into a bare `gh` usage dump that names no cause, so the
 * two sets are separated here rather than inside the wrapper's own argument parser, whose
 * output the preflight still needs in full.
 */

/**
 * Boolean flags the wrapper consumes itself; `gh` has never accepted them. Booleans carry
 * no value, so dropping one must not swallow the token after it — a positional such as the
 * PR number in `pr edit --no-remote-branch-check 2823` lives there.
 */
const WRAPPER_ONLY_BOOLEAN_FLAGS = new Set(["--no-remote-branch-check", "--json"]);

/**
 * Valued flags a given `gh pr` subcommand rejects. `gh pr edit` takes `--base` but not
 * `--head`; `gh pr create` takes both. Dropping a valued flag drops its value too.
 */
const UNSUPPORTED_VALUED_FLAGS: Record<string, Set<string>> = {
  create: new Set<string>(),
  edit: new Set(["--head"]),
};

/**
 * Drop wrapper-only and subcommand-invalid flags, forwarding everything else untouched.
 * The default is to forward: an unknown subcommand keeps its args rather than being
 * guessed at, so a wrong verdict here can only ever be a loud `gh` usage error, never a
 * quietly malformed PR.
 */
/** Whether argv already carries a PR body, so the wrapper must not append its own. */
export function hasBodyArg(args: string[]): boolean {
  return args.some((arg) => arg === "--body-file" || arg === "-F" || arg === "--body" || arg.startsWith("--body-file=") || arg.startsWith("--body="));
}

export function ghPassthroughArgs(subcommand: string, argv: string[]): string[] {
  const valuedDrops = UNSUPPORTED_VALUED_FLAGS[subcommand] ?? new Set<string>();
  const kept: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const name = eq === -1 ? arg : arg.slice(0, eq);
    if (WRAPPER_ONLY_BOOLEAN_FLAGS.has(name)) continue;
    if (valuedDrops.has(name)) {
      // `--flag=value` is self-contained; `--flag value` also consumes the next token.
      if (eq === -1 && index + 1 < argv.length && !argv[index + 1].startsWith("--")) index += 1;
      continue;
    }
    kept.push(arg);
  }
  return kept;
}
