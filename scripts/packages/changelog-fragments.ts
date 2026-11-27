import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";

export type ChangelogFragmentKind = "action_required" | "deprecation" | "fix" | "feature";
export type ChangelogFragmentAudience = "npm" | "starter";
export type ChangelogFragmentMeta = {
  kind: ChangelogFragmentKind;
  audience: ChangelogFragmentAudience;
};
export type ParsedChangelogFragment = {
  meta: ChangelogFragmentMeta;
  body: string;
};
export type ChangelogFragment = { path: string; contents: string };

const ALLOWED_KINDS = new Set<ChangelogFragmentKind>(["action_required", "deprecation", "fix", "feature"]);
const ALLOWED_AUDIENCES = new Set<ChangelogFragmentAudience>(["npm", "starter"]);
const PLACEHOLDER_LITERAL = "For the next 1.x release.";

export const isChangelogFragmentArea = (path: string): boolean => /^packages\/(?:core|outbox|platform)\/changes(?:\/|$)/u.test(path);
export const isChangelogFragment = (path: string): boolean => /^packages\/(?:core|outbox|platform)\/changes\/[^/]+\.md$/u.test(path);

function unquoteFrontmatterValue(raw: string): string {
  const trimmed = raw.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function defaultAudienceForPath(path: string): ChangelogFragmentAudience {
  return posix.basename(path).startsWith("starter-") ? "starter" : "npm";
}

/**
 * Parses optional minimalist YAML frontmatter (`kind`, `audience`) from a changelog fragment
 * and returns the metadata alongside the body with frontmatter completely stripped.
 */
export function parseChangelogFragment({ path, contents }: ChangelogFragment): ParsedChangelogFragment {
  let kind: ChangelogFragmentKind = "feature";
  let audience: ChangelogFragmentAudience = defaultAudienceForPath(path);
  let body = contents.startsWith("\uFEFF") ? contents.slice(1) : contents;

  const open = /^---[ \t]*(?:\r?\n|$)/u.exec(body);
  if (open) {
    const rest = body.slice(open[0].length);
    const close = /^---[ \t]*(?:\r?\n|$)/mu.exec(rest);
    if (!close) throw new Error(`${path}: unterminated frontmatter in changelog fragment`);
    const header = rest.slice(0, close.index);
    const seen = new Set<string>();
    for (const rawLine of header.split(/\r?\n/u)) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = /^([A-Za-z0-9_-]+)[ \t]*:[ \t]*(.*)$/u.exec(line);
      if (!match) throw new Error(`${path}: malformed frontmatter line in changelog fragment: ${line}`);
      const key = match[1]!;
      const value = unquoteFrontmatterValue(match[2]!);
      if (seen.has(key)) throw new Error(`${path}: duplicate frontmatter key "${key}" in changelog fragment`);
      seen.add(key);
      if (key === "kind") {
        if (!ALLOWED_KINDS.has(value as ChangelogFragmentKind)) {
          throw new Error(`${path}: invalid frontmatter kind "${value}" in changelog fragment; expected action_required, deprecation, fix, or feature`);
        }
        kind = value as ChangelogFragmentKind;
      } else if (key === "audience") {
        if (!ALLOWED_AUDIENCES.has(value as ChangelogFragmentAudience)) {
          throw new Error(`${path}: invalid frontmatter audience "${value}" in changelog fragment; expected npm or starter`);
        }
        audience = value as ChangelogFragmentAudience;
      } else {
        throw new Error(`${path}: unknown frontmatter key "${key}" in changelog fragment; only kind and audience are allowed`);
      }
    }
    body = rest.slice(close.index + close[0].length).replace(/^(?:[ \t]*\r?\n)+/u, "");
  }

  return { meta: { kind, audience }, body };
}

/** The only implicit publication carrier: regular non-executable Markdown, never a directory or script. */
export function validateChangelogFragment(path: string, bytes: string | Buffer, mode: string): string {
  if (!isChangelogFragment(path) || mode !== "100644") throw new Error(`${path}: fragment must be changes/*.md, regular and non-executable`);
  const decoded = typeof bytes === "string" ? bytes : new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const contents = decoded.startsWith("\uFEFF") ? decoded.slice(1) : decoded;
  if (!contents.trim() || Buffer.from(contents).some((byte) => (byte < 0x20 && byte !== 9 && byte !== 10 && byte !== 13) || byte === 0x7f)) throw new Error(`${path}: empty or malformed changelog fragment`);
  if (/^[\t ]*(?:<{7}|={7}|>{7}|\|{7})/mu.test(contents)) throw new Error(`${path}: fragment refuses conflict markers`);
  const { body } = parseChangelogFragment({ path, contents });
  if (!body.trim()) throw new Error(`${path}: empty or malformed changelog fragment`);
  if (/^\s{0,3}#{1,2}(?:\s|$)/mu.test(body)) throw new Error(`${path}: fragment refuses # and ## headings`);
  if (body.includes(PLACEHOLDER_LITERAL)) throw new Error(`${path}: fragment refuses placeholder "${PLACEHOLDER_LITERAL}"`);
  const migration = /^\s*Migration:/mu.exec(body);
  if (migration) {
    const beforeMigration = body.slice(0, migration.index);
    const hasProse = beforeMigration.split(/\r?\n/u).some((line) => line.trim() !== "" && !/^\s*#{1,6}(?:\s|$)/u.test(line));
    if (!hasProse) throw new Error(`${path}: fragment refuses orphaned Migration: block without preceding descriptive prose`);
  }
  return contents;
}

export function readChangelogFragments(root: string, directory: string): ChangelogFragment[] {
  const area = `${directory}/changes`;
  if (!isChangelogFragmentArea(area) || !existsSync(join(root, area))) return [];
  if (!lstatSync(join(root, area)).isDirectory()) throw new Error(`${area}: fragment carrier must be a directory`);
  return readdirSync(join(root, area)).map((name) => `${area}/${name}`).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map((path) => {
    const stat = lstatSync(join(root, path));
    if (!stat.isFile()) throw new Error(`${path}: fragment must be a regular file, not a nested directory or link`);
    return { path, contents: validateChangelogFragment(path, readFileSync(join(root, path)), stat.mode & 0o111 ? "100755" : "100644") };
  });
}
