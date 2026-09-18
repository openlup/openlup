// `includeFiles` declaration reader and coverage matcher for hosted functions.
//
// WHY: a file the platform's tracer cannot follow only reaches the lambda when the
// function declares it in `includeFiles`. Deciding whether a required artifact is
// covered therefore means matching a repo-root-relative path against the exact
// glob string committed in `config/platform-runtime.json` (from which
// the deployed project config is generated) — incident
// `staging-run-31686579103-attempt-1`.
//
// WHY NOT a general glob library or a permissive hand-rolled matcher: a match
// this guard reports is a promise about what the *platform* will package. An
// over-permissive matcher would vouch for a lambda that still ships without the
// file, i.e. exactly the green-PR-then-red-staging failure the guard exists to
// stop, and a new dependency is not warranted for four committed strings.
//
// SO: support exactly the committed shape — one string, at most one non-nested
// `{a,b,c}` group, `**` for any depth including zero, `*` within one segment —
// and THROW on anything else. Fail closed: an unsupported shape stops the guard
// loudly instead of being silently mis-evaluated. (Array `includeFiles` is
// already rejected earlier by the generated-config guard.)
import { readFileSync } from "node:fs";
import { join } from "node:path";

export function readIncludeGlobs(root = process.cwd()): Map<string, string> {
  const out = new Map<string, string>();
  let functions: Record<string, { includeFiles?: unknown }> | undefined;
  try {
    functions = JSON.parse(readFileSync(join(root, "config", "platform-runtime.json"), "utf8")).functions;
  } catch {
    return out;
  }
  for (const [key, value] of Object.entries(functions ?? {})) {
    if (value?.includeFiles === undefined) continue;
    if (typeof value.includeFiles !== "string") {
      throw new Error(
        `config/platform-runtime.json functions["${key}"].includeFiles must be one brace-glob string; ` +
          `got ${JSON.stringify(value.includeFiles)}`,
      );
    }
    out.set(key, value.includeFiles);
  }
  return out;
}

function expandBraceGroup(glob: string): string[] {
  const open = glob.indexOf("{");
  const close = glob.indexOf("}", open + 1);
  if (open === -1) {
    if (glob.includes("}")) throw new Error(`unsupported includeFiles glob (unbalanced brace): ${glob}`);
    return [glob];
  }
  if (close === -1) throw new Error(`unsupported includeFiles glob (unbalanced brace): ${glob}`);
  const body = glob.slice(open + 1, close);
  const tail = glob.slice(close + 1);
  if (body.includes("{") || tail.includes("{") || tail.includes("}")) {
    throw new Error(`unsupported includeFiles glob (nested or multiple brace groups): ${glob}`);
  }
  return body.split(",").map((alternative) => glob.slice(0, open) + alternative + tail);
}

function globToRegExp(glob: string): RegExp {
  if (/[?[\]()!+@]/.test(glob)) {
    throw new Error(`unsupported includeFiles glob (only *, ** and one brace group are supported): ${glob}`);
  }
  const segments = glob.split("/");
  let pattern = "";
  segments.forEach((segment, index) => {
    const isLast = index === segments.length - 1;
    if (segment === "**") {
      // Any depth, including zero directories — but a trailing `**` still needs a
      // file to match, so `edge/functions/**` does not cover the bare dir. `(?!\.)`
      // mirrors glob's dotfile rule: a wildcard never matches a leading dot.
      pattern += isLast ? "(?:(?!\\.)[^/]+/)*(?!\\.)[^/]+" : "(?:(?!\\.)[^/]+/)*";
      return;
    }
    if (segment.includes("**")) throw new Error(`unsupported includeFiles glob (** must be a whole segment): ${glob}`);
    if (segment.startsWith("*")) pattern += "(?!\\.)";
    pattern += segment.split("*").map((part) => part.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("[^/]*");
    if (!isLast) pattern += "/";
  });
  return new RegExp(`^${pattern}$`);
}

/** Match a repo-root-relative POSIX path against one committed `includeFiles` string. */
export function matchesIncludeGlob(glob: string, relPosixPath: string): boolean {
  return expandBraceGroup(glob).some((alternative) => globToRegExp(alternative).test(relPosixPath));
}
