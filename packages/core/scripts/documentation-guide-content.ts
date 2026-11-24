import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { repositoryUrl } from "./documentation-sql-inventory.ts";

// Reader guide Markdown rules shared by Core docs:check and the dependency-free release-page audit.

function markdownLinkTargets(source: string, refuse: (reason: string) => void): string[] {
  // Inspect destination delimiters conservatively; nested/escaped label text
  // and blockquote/list containers must not hide a package-local target.
  const inline = [...source.matchAll(/\]\([ \t\r\n]*/g)]
    .map((match) => linkDestination(source.slice(match.index + match[0].length), refuse));
  // Generated declarations contain index signatures, not link definitions.
  const referenceSource = source
    .replace(/^ {0,3}(`{3,})[^`\r\n]*\r?\n[\s\S]*?^ {0,3}\1`*[ \t]*\r?$/gm, "")
    .replace(/^ {0,3}(~{3,})[^\r\n]*\r?\n[\s\S]*?^ {0,3}\1~*[ \t]*\r?$/gm, "");
  const references = [...referenceSource.matchAll(/\[(?:\\.|[^\]\\])+\]:[ \t\r\n]*/g)]
    .map((match) => linkDestination(referenceSource.slice(match.index + match[0].length), refuse));
  const html = [...source.matchAll(/<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)].flatMap(([element]) => {
    // Consume whole attribute values: href-like text or > inside a title is not a boundary.
    // HTML whitespace only: a no-break space is part of an attribute name, not a separator.
    for (const attribute of element.slice(2, -1).matchAll(/([^\t\n\f\r =/>]+)(?:[\t\n\f\r ]*=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+)))?/g)) {
      if (attribute[1]!.toLowerCase() === "href") return [attribute[2] ?? attribute[3] ?? attribute[4] ?? ""];
    }
    return [];
  });
  // CommonMark autolinks: `<scheme:...>` with no spaces, controls or angle brackets.
  const autolinks = [...source.matchAll(/<([A-Za-z][A-Za-z0-9+.-]{1,31}:[^<>\s]*)>/g)].map((match) => match[1]!);
  return [...inline, ...references, ...html, ...autolinks].filter((target): target is string => target !== undefined);
}

function linkDestination(source: string, refuse: (reason: string) => void): string | undefined {
  // Inspect the destination independently of optional title syntax. Unknown
  // boundaries refuse explicitly instead of disappearing from the inventory.
  const angle = source.startsWith("<");
  let depth = 0;
  const start = angle ? 1 : 0;
  for (let end = start; end < source.length; end++) {
    const character = source[end];
    if (character === "\\" && end + 1 < source.length) { end++; continue; }
    if (angle) {
      if (character === ">") return source.slice(start, end);
      if (character === "\r" || character === "\n") break;
    } else {
      if (character === "(") depth++;
      else if (character === ")" && depth > 0) depth--;
      else if (character === ")" || /[ \t\r\n]/.test(character ?? "")) {
        if (depth === 0) return source.slice(start, end);
        break;
      }
    }
  }
  if (!angle && depth === 0 && source.length > 0) return source;
  refuse("unsupported Markdown link destination boundary; use a balanced destination or an angle-delimited path");
  return undefined;
}

function isExternalOrAnchor(target: string): boolean {
  return target === "" || target.startsWith("#") || target.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(target);
}

export const guideAllowListPath = "config/documentation-guide-allowlist.json";
const absoluteFilesystemPath = /(?<![\w.~:/-])(?:file:\/\/)?\/(?:Users|home)\/[A-Za-z0-9._-]+|(?<![\w\\])[A-Za-z]:[\\/]Users[\\/][A-Za-z0-9._-]+/g;
// Repository-internal language that a reader of the guide cannot resolve.
const readerLanguagePatterns: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b[A-Z]{1,2}\d{1,3}[a-z]?\d?\b/g, "task or milestone ID"],
  [/\boss-[a-z]+\d*(?:-[a-z0-9]+)+\b|\bdocumentation-programme\b/g, "plan name"],
  [/(?<![\w.-])(?:tests|\.context|docs\/platform\/plans)\//g, "path into tests, plans or agent scratch"],
  [/\b(?:merge[ -](?:queue|group)s?|required (?:context|job)s?|install-proof|self-check|ci:required|review (?:floor|receipt)s?|coordinator|shards?|supervisor|maintainer read|task records?|worktrees?|falsifiers?)\b/gi, "CI or delivery-process vocabulary"],
  [absoluteFilesystemPath, "absolute filesystem path"],
];

export function pinGuideReleaseLinks(source: string, version: string, acceptRef?: (ref: string) => boolean): string {
  return source.replace(/(https:\/\/github\.com\/openlup\/openlup\/blob\/openlup-core-v)([0-9A-Za-z.+-]+)\//g,
    (link: string, prefix: string, ref: string) => acceptRef && !acceptRef(ref) ? link : `${prefix}${version}/`);
}

export function assertGuideTitle(label: string, source: string, violations: string[]): void {
  let headings = 0;
  let closingFence: RegExp | undefined;
  for (const line of source.split(/\r?\n/)) {
    if (closingFence) {
      if (closingFence.test(line)) closingFence = undefined;
      continue;
    }
    const fence = /^ {0,3}(`{3,})([^`]*$)|^ {0,3}(~{3,})/.exec(line);
    if (fence) {
      const marker = fence[1] ?? fence[3]!;
      closingFence = new RegExp(`^ {0,3}${marker[0]}{${marker.length},}[ \\t]*$`);
      continue;
    }
    if (/^ {0,3}#(?:[ \t]|$)/.test(line)) headings++;
  }
  if (headings !== 1) violations.push(`${label}: a guide page has exactly one level-one heading, its title (found ${headings})`);
}

export function readGuideAllowList(repositoryRoot: string, violations: string[]): Set<string> {
  const path = join(repositoryRoot, guideAllowListPath);
  if (!existsSync(path)) {
    violations.push(`${guideAllowListPath}: missing reader-language allow-list`);
    return new Set();
  }
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { schemaVersion?: unknown; terms?: unknown };
  const terms = parsed.terms;
  if (parsed.schemaVersion !== 1 || !Array.isArray(terms) || terms.some((term) => typeof term !== "string" || term.trim() !== term || term === "")) {
    violations.push(`${guideAllowListPath}: expected schemaVersion 1 and a list of exact terms`);
    return new Set();
  }
  return new Set(terms as string[]);
}

export function assertReaderLanguage(label: string, source: string, allowed: ReadonlySet<string>, violations: string[]): void {
  for (const [pattern, description] of readerLanguagePatterns) {
    const found = new Set([...source.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => match[0]).filter((term) => !allowed.has(term)));
    if (found.size) violations.push(`${label}: repository-internal language (${description}): ${[...found].join(", ")}`);
  }
}

const canonicalRepositoryLink = /^https:\/\/github\.com\/openlup\/openlup(?:\/?(?:[?#].*)?|\/blob\/[^\s]+|\/issues(?:[/?#].*)?)$/;

// Markdown and HTML decode character references in destinations, so `&#47;` (or HTML's
// semicolonless `&#47`) would hide a path separator from the link rules. The rules read the
// decoded text, and a destination may carry no `&` except `&amp;`: anything else is refused
// rather than interpreted.
const characterReference = /&(?:#(\d+);?|#[xX]([0-9A-Fa-f]+);?|([A-Za-z][A-Za-z0-9]*);)/g;
const namedReferences: Record<string, string> = { amp: "&", sol: "/", colon: ":", period: ".", num: "#", quest: "?", percnt: "%", lt: "<", gt: ">", quot: '"', apos: "'", equals: "=" };
function decodeCharacterReferences(source: string): string {
  return source.replace(characterReference, (reference, decimal?: string, hex?: string, name?: string) => {
    const code = decimal !== undefined ? Number(decimal) : hex !== undefined ? Number.parseInt(hex, 16) : undefined;
    if (code !== undefined) return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : reference;
    return namedReferences[name!] ?? reference;
  });
}

export function assertGuideLinks(guideRoot: string, file: string, label: string, raw: string, repositoryRoot: string, tag: string, violations: string[], fixes?: Set<GuidePageFix>): void {
  const report = (message: string, fix: GuidePageFix = "content") => {
    violations.push(`${label}: ${message}`);
    fixes?.add(fix);
  };
  for (const target of markdownLinkTargets(raw, () => undefined)) {
    if (/&(?!amp;)/.test(target)) {
      report(`link destination ${target} uses a character reference or a bare &; write the characters literally and an ampersand as &amp;`);
    }
  }
  const source = decodeCharacterReferences(raw);
  // Find delimiters in raw source so decoded quotes and angles cannot split HTML values.
  const targets = markdownLinkTargets(raw, (reason) => report(reason)).map(decodeCharacterReferences);
  // Browsers normalise a destination before following it (percent-encoded or mixed-case hosts,
  // tabs and newlines, backslashes, default ports, user info). Parse each destination as a browser
  // does; one that reaches GitHub must already be written in the parser's own canonical
  // spelling and in an admitted shape, so no spelling can reach an unchecked GitHub URL.
  const reachesGitHub = (spelling: string): boolean => {
    let url: URL;
    try { url = new URL(spelling, "https://guide.invalid/guide/"); } catch { return false; }
    const host = url.hostname.replace(/\.+$/, "").toLowerCase();
    return /^(?:www\.)?github\.com$|^raw\.githubusercontent\.com$/.test(host);
  };
  // Candidates are not only parsed link destinations: every attribute value of every HTML tag
  // (split on HTML whitespace, so no parser disagreement can choose a different value) and every
  // URL-shaped token in the text (GitHub links bare URLs) are classified the same way.
  const candidates = new Set<string>(targets);
  for (const [tag] of raw.matchAll(/<[A-Za-z][^\s/>]*(?:[^>"']|"[^"]*"|'[^']*')*>/g)) {
    for (const value of tag.matchAll(/=[\t\n\f\r ]*(?:"([^"]*)"|'([^']*)'|([^\t\n\f\r "'=<>`]+))/g)) {
      candidates.add(decodeCharacterReferences(value[1] ?? value[2] ?? value[3] ?? ""));
    }
  }
  const bareLinkSource = source.replace(/(?:[A-Za-z][A-Za-z0-9+.-]*:|\/\/|www\.)[^\s<>"'`[\]{}|^]+/g, (token) => {
    // GFM bare autolinks omit trailing punctuation and unmatched closing parentheses.
    let target = token.replace(/[.,;:!?*_~]+$/, "");
    let excess = (target.match(/\)/g)?.length ?? 0) - (target.match(/\(/g)?.length ?? 0);
    while (target.endsWith(")") && excess > 0) {
      target = target.slice(0, -1).replace(/[.,;:!?*_~]+$/, "");
      excess--;
    }
    candidates.add(target);
    return target;
  });
  for (const target of candidates) {
    // An HTML attribute is followed as written but without tabs and newlines; Markdown first
    // removes backslash escapes; GitHub links bare `www.` text as http.
    const unescaped = target.replace(/\\([!-/:-@[-`{-~])/g, "$1");
    const spellings = [target, unescaped, target.replace(/[\t\n\r]/g, "")]
      .flatMap((spelling) => /^www\./i.test(spelling) ? [spelling, `http://${spelling}`] : [spelling]);
    if (!spellings.some(reachesGitHub)) continue;
    let canonical: string | undefined;
    try { canonical = new URL(target).href; } catch { canonical = undefined; }
    if (canonical !== target || !canonicalRepositoryLink.test(target)) {
      const form = canonical && canonicalRepositoryLink.test(canonical)
        ? `canonical form is ${canonical}` : `use ${repositoryUrl}/blob/${tag}/<path>`;
      report(`non-canonical repository link ${target}; ${form}`,
        fixes && target.startsWith(`${repositoryUrl}/blob/`) ? "unpinned-blob" : "content");
    }
  }
  for (const target of targets) {
    if (isExternalOrAnchor(target)) continue;
    const local = resolve(dirname(file), safeDecode(target.split(/[?#]/, 1)[0] ?? ""));
    if (local !== guideRoot && !local.startsWith(`${guideRoot}${sep}`)) {
      report(`link ${target} leaves the guide; use ${repositoryUrl}/blob/${tag}/<path>`);
    }
  }
  const canonical = `${repositoryUrl}/blob/${tag}/<path>`;
  // Retain the conservative text scans and the untrimmed explicit destinations/attributes.
  const candidateSource = [bareLinkSource, ...candidates].join("\n");
  // Every link into the repository, with or without a scheme, is either a file at the release tag
  // (checked below), the repository itself or its issue tracker; raw, blame, tree, branch and
  // protocol-relative forms would bypass the release-tag and path checks.
  // GitHub also links bare `www.` text, so that form counts as a repository link too.
  for (const [url] of candidateSource.matchAll(/(?:(?:https?:)?\/\/(?:www\.github\.com|raw\.githubusercontent\.com|github\.com)|(?<![\w./-])www\.github\.com)\/openlup\/openlup(?=\/|$|[\s)>"'`?#])[^\s)>"'`]*/gi)) {
    const rest = url.startsWith(repositoryUrl) ? url.slice(repositoryUrl.length) : undefined;
    if (rest === undefined || !/^(?:\/?(?:[?#].*)?|\/blob\/.*|\/issues(?:[/?#].*)?)$/.test(rest)) {
      report(`non-canonical repository link ${url}; use ${canonical}`);
    }
  }
  for (const match of candidateSource.matchAll(/https:\/\/github\.com\/openlup\/openlup\/(blob|tree)\/([^/\s)>"'`]+)\/?([^\s)>"'`#?]*)/g)) {
    const [url, kind, ref, path] = match;
    if (ref !== tag) {
      report(`repository link ${url} must pin ${tag}; run docs:check -- --write`, kind === "blob" ? "unpinned-blob" : "content");
      continue;
    }
    const target = repositoryLinkTarget(repositoryRoot, guideRoot, path ?? "");
    if (target === "missing") {
      report(`repository link ${url} targets a path missing from the repository`, "repository-target");
    } else if (target === "guide") {
      report(`repository link ${url} points into the guide; use a relative link`, "relative-link");
    }
  }
}

function repositoryLinkTarget(repositoryRoot: string, guideRoot: string, path: string): "missing" | "guide" | "repository" {
  const decoded = safeDecode(path);
  const resolved = resolve(repositoryRoot, decoded);
  if (!decoded || !resolved.startsWith(`${repositoryRoot}${sep}`) || !existsSync(resolved)) return "missing";
  return (resolved === guideRoot || resolved.startsWith(`${guideRoot}${sep}`)) && decoded.endsWith(".md") ? "guide" : "repository";
}

function safeDecode(value: string): string {
  try { return decodeURIComponent(value); } catch { return value; }
}

function assertLocalMarkdownLinks(
  { packageRoot, file, label, source, packed }: { packageRoot: string; file: string; label: string; source: string; packed: ReadonlySet<string> },
  violations: string[],
  diagnosticLabel: string,
): void {
  for (const target of markdownLinkTargets(source, (reason) => violations.push(`${diagnosticLabel}: ${reason}`))) {
    if (isExternalOrAnchor(target)) continue;
    // Do not interpret an entity or Unicode separator as a different packed
    // destination. Authors can use literal punctuation or percent encoding.
    if (/[&<>]|[^\S \t\r\n]/u.test(target)) {
      violations.push(`${diagnosticLabel}: unsupported local link destination ${target}; use literal punctuation or percent encoding, and ASCII title separators`);
      continue;
    }
    const unescaped = target.replace(/\\([!-/:-@[-`{-~])/g, "$1");
    let cleanTarget: string;
    try {
      cleanTarget = decodeURIComponent(unescaped.split(/[?#]/, 1)[0] ?? "");
    } catch {
      violations.push(`${diagnosticLabel}: malformed percent encoding in local link ${target}`);
      continue;
    }
    const resolvedTarget = resolve(dirname(file), cleanTarget);
    const insidePackage = resolvedTarget === packageRoot || resolvedTarget.startsWith(`${packageRoot}${sep}`);
    // The caller supplied this page's contents, even when it has yet to be written.
    if (!insidePackage) {
      violations.push(`${diagnosticLabel}: local link escapes package ${target}`);
    } else if (!cleanTarget || (resolvedTarget !== file && !existsSync(resolvedTarget))) {
      violations.push(`${diagnosticLabel}: dangling local link ${target}`);
    } else if (packed.has(label) && !packed.has(relative(packageRoot, resolvedTarget).split(sep).join("/"))) {
      violations.push(`${diagnosticLabel}: local link ${target} targets a file missing from npm pack`);
    }
  }
}

const downstreamRepositoryCommand = "veli";
const monorepoPackagePath = /(^|\W)packages\/core(?:\/|\b)/;
const forbiddenExtractedRootReferences = [
  [/\bnpm\s+--workspace\b/, "monorepo workspace command"],
  [
    new RegExp(`(^|[^A-Za-z0-9_])\\./${downstreamRepositoryCommand}(?=$|[^A-Za-z0-9_/-])`),
    "downstream repository command",
  ],
  [/\bdocs\/OSS_READINESS\.md\b/, "downstream readiness document"],
  [/\bpackages\/(?:ui|create-[a-z0-9-]+)\b/, "sibling monorepo package"],
];
const releaseUrlPattern = () => /https:\/\/github\.com\/openlup\/openlup\/(?:blob|tree)\/openlup-core-v[0-9A-Za-z.+-]+\/[^\s)>"'`]*/g;

// Match the physical lines and fence boundaries used by openlup-context's Markdown reader.
function withoutGeneratedReportReferences(source: string, allowSummaries: boolean): string {
  let fence: string | undefined;
  return source.split("\n").map((line) => {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)[ \t]*\r?$/u.test(line)) fence = undefined;
      return line;
    }
    if (marker) fence = marker;
    const reportHeading = /^### `packages\/core\/api\/[a-z0-9-]+\.api\.md`$/u.test(line);
    const reportSummary = allowSummaries && /^Added declarations: [1-9][0-9]*; see `packages\/[a-z0-9-]+\/api\/[a-z0-9-]+\.api\.md`\.$/u.test(line);
    return reportHeading || reportSummary ? "" : line;
  }).join("\n");
}

export type Fence = { code: string; line: number; nocheck: boolean; extension: string };

export function typeScriptFences(source: string): Fence[] {
  const fences: Fence[] = [];
  const lines = source.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const open = /^ {0,3}(`{3,}|~{3,})\s*([^\s`]*)(.*)$/.exec(lines[index] ?? "");
    if (!open) continue;
    const [, marker, language, rest] = open;
    let end = index + 1;
    while (end < lines.length && !new RegExp(`^ {0,3}${marker![0]}{${marker!.length},}\\s*$`).test(lines[end] ?? "")) end++;
    if (/^(?:ts|typescript|tsx|mts|cts)$/i.test(language ?? "")) {
      fences.push({ code: `${lines.slice(index + 1, end).join("\n")}\n`, line: index + 2, nocheck: /^\s+nocheck(?:\s|$)/.test(rest ?? ""), extension: ["tsx", "mts", "cts"].includes(language!.toLowerCase()) ? language!.toLowerCase() : "ts" });
    }
    index = end;
  }
  return fences;
}

export function checkedTypeScriptFences(label: string, source: string, violations: string[]): Fence[] {
  return typeScriptFences(source).filter((fence) => {
    if (!fence.nocheck) return true;
    if (!/^\/\/\s*\S/.test(fence.code)) violations.push(`${label}:${fence.line}: a ts nocheck fence must open with a // reason line`);
    return false;
  });
}

type PackageMarkdown = {
  packageRoot: string;
  file: string;
  label: string;
  source: string;
  packed: ReadonlySet<string>;
  scripts?: Readonly<Record<string, string>>;
};

export function assertPackageMarkdown(
  { packageRoot, file, label, source, packed, scripts }: PackageMarkdown,
  guide: boolean,
  violations: string[],
  diagnosticLabel = label,
): void {
  // A pinned repository URL in the guide is the published link form, not an extracted-root path.
  const scanned = guide ? source.replace(releaseUrlPattern(), "") : source;
  // Generated release notes carry report headings and addition summaries as inline paths.
  const versionedUpgradePage = /^docs\/guide\/upgrade\/v\d+-\d+-\d+(?:-[A-Za-z0-9-]+)?\.md$/u.test(label);
  const pathSource = /^docs\/guide\/upgrade\/v[^/]*\.md$/.test(label)
    ? withoutGeneratedReportReferences(source, versionedUpgradePage).replace(releaseUrlPattern(), "")
    : scanned;
  if (monorepoPackagePath.test(pathSource)) violations.push(`${diagnosticLabel}: monorepo package path`);
  for (const [pattern, description] of forbiddenExtractedRootReferences) {
    if ((pattern as RegExp).test(scanned)) violations.push(`${diagnosticLabel}: ${description}`);
  }
  assertLocalMarkdownLinks({ packageRoot, file, label, source, packed }, violations, diagnosticLabel);
  for (const match of source.matchAll(/\bnpm run (?:--silent )?([A-Za-z0-9:_-]+)/g)) {
    const script = match[1];
    if (!scripts?.[script]) violations.push(`${diagnosticLabel}: unknown npm script ${script}`);
  }
}

type GuidePage = PackageMarkdown & {
  repositoryRoot: string;
  guideRoot: string;
  tag: string;
  allowed: ReadonlySet<string>;
  syncRegions?: (source: string) => string;
  fragmentPath?: string;
  fixes?: Set<GuidePageFix>;
};

export type GuidePageFix = "unpinned-blob" | "relative-link" | "repository-target" | "generated-region" | "content";

/** Apply the installed contract's page rules to Markdown before compiling its checked fences. */
export function assertGuidePage(page: GuidePage, violations: string[]): Fence[] {
  const { source, label, file, repositoryRoot, guideRoot, allowed, tag, syncRegions, fragmentPath, fixes } = page;
  const diagnosticLabel = fragmentPath ?? label;
  if (!syncRegions && source.includes("<!-- generated:")) {
    violations.push(`${diagnosticLabel}: generated regions are forbidden in upgrade pages`);
    fixes?.add("generated-region");
  }
  const guideSource = syncRegions ? syncRegions(source) : source;
  let count = violations.length;
  if (!fragmentPath) assertGuideTitle(diagnosticLabel, guideSource, violations);
  if (violations.length > count) fixes?.add("content");
  assertGuideLinks(guideRoot, file, diagnosticLabel, guideSource, repositoryRoot, tag, violations, fixes);
  count = violations.length;
  assertReaderLanguage(diagnosticLabel, guideSource, allowed, violations);
  assertPackageMarkdown(page, true, violations, diagnosticLabel);
  const fences = checkedTypeScriptFences(diagnosticLabel, source, violations);
  if (violations.length > count) fixes?.add("content");
  return fences;
}
