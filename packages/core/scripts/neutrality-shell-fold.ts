/**
 * A shell alias is the same evasion as string concatenation with different punctuation:
 * `STACK_DIR="<vendor>"` written once and dereferenced as `"$STACK_DIR"` thirty-eight times reads
 * as one occurrence instead of thirty-nine, so a scrub that changes nothing about what the file
 * means can buy a family counter back. Folding it back is therefore a measurement fix - which is
 * exactly why the fold has to be as literal as the shell is, in both directions. A fold that binds
 * a name the shell never bound invents hits that are not in the tree; a fold that lets a line of
 * prose rebind a name silently switches itself off for that name, which is the evasion again with
 * a `#` in front of it.
 *
 * So a binding is read only from an assignment the shell is certain to have executed, with the
 * value it is certain to have had, and the two failure directions are answered differently:
 *
 * - Text that is not code - a comment, a here-document body - is **skipped**. It never binds and
 *   never poisons, so a line of prose can neither add a hit nor disable the fold.
 * - Code whose effect is real but not certain - `local`, a subshell, a conditional or loop body -
 *   makes the name **ambiguous**, so it folds nowhere. Guessing there would fabricate hits, and
 *   unlike a comment, adding such a block genuinely changes what the file does.
 */

type Region = { start: number; end: number };

type Binding = { value: string; at: number };

const ASSIGNMENT =
  /(?:^|[\s;&|(])(export|local|readonly|declare(?:\s+-[A-Za-z]+)?|typeset)?\s*([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"`\\\n]*)"|'([^'\n]*)')/gm;
const DYNAMIC = /[$`\\]/;
const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g;
/** After an assignment, any of these means the statement ended, so the binding is the shell's. */
const STATEMENT_END = /[\n\r;&|)}#]/;
/** Declarators whose binding is scoped to a function body, or carries an attribute we do not model. */
const SCOPED_DECLARATOR = /^(?:local|declare|typeset)\b/;
const WORD = /[A-Za-z_][A-Za-z0-9_]*/y;
const COMMAND_POSITION = /[\n\r;&|(){}]/;
const OPENS_COMPOUND = new Set(["if", "for", "while", "until", "case", "select"]);
const CLOSES_COMPOUND = new Set(["fi", "done", "esac"]);

type ShellShape = {
  /** Comment tails, here-document bodies, subshell and command-substitution bodies. */
  skipped: Region[];
  /** Spans inside a compound command, where an assignment may or may not run. */
  uncertain: Region[];
};

/**
 * One pass that answers both questions an assignment position raises: is this text the shell runs
 * at all, and if so, does it run unconditionally. Quoting is tracked rather than jumped over,
 * because `"$( ... )"` hides a whole command inside a string and the assignments in it are the
 * subshell's, not the file's.
 */
function shellShape(source: string): ShellShape {
  const skipped: Region[] = [];
  const uncertain: Region[] = [];
  const subshells: number[] = [];
  // Kinds, not a counter: `}` closes only a brace group and `fi`/`done`/`esac` only a keyword
  // compound, so a bare `${VAR}` read cannot cancel an enclosing `if`.
  const openers: Array<"brace" | "keyword"> = [];
  let index = 0;
  let previous = "\n";
  let quoted = false;
  let depthStart = -1;
  const openCompound = (kind: "brace" | "keyword") => {
    if (openers.length === 0) depthStart = index;
    openers.push(kind);
  };
  const closeCompound = (kind: "brace" | "keyword") => {
    if (openers[openers.length - 1] !== kind) return;
    openers.pop();
    if (openers.length === 0) uncertain.push({ start: depthStart, end: index });
  };
  const atCommandPosition = () => previous === "" || COMMAND_POSITION.test(previous) || /\s/.test(previous);
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") { previous = char; index += 2; continue; }
    if (char === "$" && source[index + 1] === "(") { subshells.push(index + 2); previous = "("; index += 2; continue; }
    if (char === "`") {
      const close = source.indexOf("`", index + 1);
      const end = close === -1 ? source.length : close;
      skipped.push({ start: index + 1, end });
      previous = "`";
      index = end + 1;
      continue;
    }
    if (char === ")" && subshells.length > 0) {
      skipped.push({ start: subshells.pop() as number, end: index });
      previous = char;
      index += 1;
      continue;
    }
    if (quoted) {
      if (char === '"') quoted = false;
      previous = char;
      index += 1;
      continue;
    }
    if (char === '"') { quoted = true; previous = char; index += 1; continue; }
    if (char === "'") {
      const close = source.indexOf("'", index + 1);
      previous = "'";
      index = close === -1 ? source.length : close + 1;
      continue;
    }
    if (char === "#" && /[\s;&|(]/.test(previous)) {
      const newline = source.indexOf("\n", index);
      const end = newline === -1 ? source.length : newline;
      skipped.push({ start: index, end });
      previous = "\n";
      index = end;
      continue;
    }
    if (char === "<" && source[index + 1] === "<" && source[index + 2] !== "<") {
      const body = heredocBody(source, index);
      if (body) { skipped.push(body); previous = "\n"; index = body.end; continue; }
    }
    if (char === "(" && atCommandPosition() && previous !== ")") { subshells.push(index + 1); previous = char; index += 1; continue; }
    if (char === "{" && atCommandPosition()) { openCompound("brace"); previous = char; index += 1; continue; }
    if (char === "}") { closeCompound("brace"); previous = char; index += 1; continue; }
    if (/[A-Za-z_]/.test(char) && !/[A-Za-z0-9_]/.test(previous)) {
      WORD.lastIndex = index;
      const word = WORD.exec(source)?.[0] ?? "";
      if (OPENS_COMPOUND.has(word)) openCompound("keyword");
      else if (CLOSES_COMPOUND.has(word)) closeCompound("keyword");
      previous = word[word.length - 1] ?? char;
      index += word.length;
      continue;
    }
    previous = char;
    index += 1;
  }
  if (openers.length > 0) uncertain.push({ start: depthStart, end: source.length });
  for (const start of subshells) skipped.push({ start, end: source.length });
  return { skipped, uncertain };
}

/**
 * A here-document body - `<<EOT ... EOT` - is text being emitted, not code being run, so an
 * assignment inside it binds nothing. The delimiter is read exactly as the shell reads it - quoted
 * or bare, `<<` or `<<-` - and `<<<` is a here-string, which has no body to skip.
 */
function heredocBody(source: string, at: number): Region | null {
  const header = /^<<-?[ \t]*(?:"([A-Za-z_][A-Za-z0-9_]*)"|'([A-Za-z_][A-Za-z0-9_]*)'|([A-Za-z_][A-Za-z0-9_]*))/
    .exec(source.slice(at, at + 80));
  if (!header) return null;
  const word = header[1] ?? header[2] ?? header[3] ?? "";
  const bodyStart = source.indexOf("\n", at + header[0].length);
  if (bodyStart === -1) return null;
  const terminator = new RegExp(`^[ \\t]*${word}[ \\t]*$`, "m").exec(source.slice(bodyStart + 1));
  const end = terminator ? bodyStart + 1 + terminator.index + terminator[0].length : source.length;
  return { start: bodyStart + 1, end };
}

const inRegion = (regions: Region[], at: number): boolean =>
  regions.some((region) => at >= region.start && at < region.end);

/**
 * `VAR=value command` scopes the binding to that one command and leaves the outer shell untouched,
 * so it must not be recorded. Whatever follows the assignment decides: a statement terminator, a
 * comment, or end of input means the assignment stood alone; anything else - another assignment in
 * the same prefix, or the command word itself - means it did not.
 */
function isCommandPrefix(source: string, assignmentEnd: number): boolean {
  let index = assignmentEnd;
  while (source[index] === " " || source[index] === "\t") index += 1;
  const next = source[index];
  return next !== undefined && !STATEMENT_END.test(next);
}

/**
 * Substitutes simple shell literal assignments into the `"$VAR"` and `${VAR}` reads that can see
 * them, so a `.sh` file counts what it means rather than how many times it spelled it out.
 *
 * Deliberate limits, each of which leaves the source untouched rather than guessing: one flat
 * namespace with no data-flow analysis; a value containing `$`, a backtick, or a backslash is never
 * recorded, so `V="$(cmd)"` and `V="$OTHER"` stay dynamic; `${!indirect}` and every
 * `${VAR:-default}` modifier form are skipped because their expansion is not a plain substitution;
 * a `VAR=value command` prefix dies with its command; and a reference only resolves against an
 * assignment that precedes it. A name is dropped outright - folding nowhere - when it is bound to
 * two different literals, or bound anywhere the shell might not have run: under `local`, `declare`
 * or `typeset`, inside a subshell or command substitution, or inside an `if`, loop, `case` or brace
 * group. Assignments in comments and here-document bodies are skipped without dropping the name,
 * so prose can neither add a binding nor take one away.
 */
export function foldShellVariableIndirection(source: string): string {
  const { skipped, uncertain } = shellShape(source);
  const bindings = new Map<string, Binding>();
  const ambiguous = new Set<string>();
  // Earlier assignments resolve inside a later one, so `A="supa"; B="${A}base"` records `B` as the
  // full term instead of losing it at the seam. Whatever is still unresolved after that - `$(cmd)`,
  // an unknown name, a backtick - keeps the value dynamic, so it is never recorded.
  const resolve = (text: string, visibleFrom: number) =>
    text.replace(REFERENCE, (whole, braced?: string, bare?: string) => {
      const name = braced ?? bare ?? "";
      const binding = bindings.get(name);
      return binding && !ambiguous.has(name) && binding.at <= visibleFrom ? binding.value : whole;
    });
  for (const match of source.matchAll(ASSIGNMENT)) {
    const start = match.index ?? 0;
    const end = start + match[0].length;
    // The match opens on the separator before the name, which for a line-leading assignment is the
    // preceding newline - one character outside the region that owns the line. The closing quote is
    // unambiguously inside it, so that is what decides which region this assignment belongs to.
    if (inRegion(skipped, end - 1)) continue;
    // A `VAR=value cmd` prefix is a construct with a defined, contained meaning, so it binds
    // nothing and drops nothing. The rest are assignments the shell may really have made, just not
    // certainly, so the name stops folding entirely rather than folding to a guess.
    if (isCommandPrefix(source, end)) continue;
    const name = match[2];
    if (SCOPED_DECLARATOR.test(match[1] ?? "") || inRegion(uncertain, end - 1)) { ambiguous.add(name); continue; }
    const value = resolve(match[3] ?? match[4] ?? "", start);
    if (DYNAMIC.test(value)) { ambiguous.add(name); continue; }
    const existing = bindings.get(name);
    if (existing && existing.value !== value) { ambiguous.add(name); continue; }
    if (!existing) bindings.set(name, { value, at: end });
  }
  for (const name of ambiguous) bindings.delete(name);
  if (bindings.size === 0) return source;
  let output = "";
  let cursor = 0;
  for (const match of source.matchAll(REFERENCE)) {
    const at = match.index ?? 0;
    const binding = bindings.get(match[1] ?? match[2] ?? "");
    if (!binding || binding.at > at || inRegion(skipped, at)) continue;
    output += source.slice(cursor, at) + binding.value;
    cursor = at + match[0].length;
  }
  return output + source.slice(cursor);
}
