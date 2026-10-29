#!/usr/bin/env node

// Opt-in development tool. Kernel exports never import this file.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type InstalledPackage = { name: string; version: string; root: string; manifest: string };
type Hit = { title: string; file: string; start: number; end: number; owner?: string; packageName: string; score: number; reason: string };

const ignoredWords = new Set(["a", "an", "and", "are", "by", "do", "for", "from", "how", "in", "is", "of", "on", "or", "the", "to", "with", "czy", "dla", "gdzie", "i", "jak", "jest", "na", "oraz", "po", "przez", "się", "w", "z"]);
const codeExtensions = new Set([".ts", ".tsx", ".js", ".jsx", ".mts", ".cts", ".mjs", ".cjs"]);
const corpusPackages = new Set(["@openlup/core", "@openlup/outbox", "@openlup/platform"]);
const skippedDirectories = new Set(["node_modules", ".git", ".next", ".turbo", "coverage", "dist", "build", ".cache"]);
const usage = "Usage: openlup-context search <task> [--code] [--json]\nRun from the application root after installing @openlup/core.\n";

function readText(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function selectedPackages(cwd: string): InstalledPackage[] {
  const scope = join(cwd, "node_modules", "@openlup");
  if (!existsSync(scope)) throw new Error("No installed @openlup/* packages found in this application root");
  const packages: InstalledPackage[] = [];
  for (const entry of readdirSync(scope, { withFileTypes: true })) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const root = join(scope, entry.name);
    const manifest = readText(join(root, "package.json"));
    if (!manifest) continue;
    const parsed = JSON.parse(manifest) as { name?: string; version?: string };
    if (parsed.name !== `@openlup/${entry.name}` || !parsed.version) throw new Error(`Invalid installed package manifest: ${root}`);
    packages.push({ name: parsed.name, version: parsed.version, root, manifest });
  }
  if (!packages.some((item) => item.name === "@openlup/core")) throw new Error("@openlup/core is required for this command");
  const versions = new Set(packages.map((item) => item.version));
  if (versions.size !== 1) throw new Error(`Mixed @openlup/* versions: ${packages.map((item) => `${item.name}@${item.version}`).join(", ")}`);
  const lock = readText(join(cwd, "package-lock.json"));
  if (lock) {
    const entries = (JSON.parse(lock) as { packages?: Record<string, { version?: string }> }).packages ?? {};
    for (const item of packages) {
      const locked = entries[`node_modules/${item.name}`]?.version;
      if (locked && locked !== item.version) throw new Error(`Lockfile and installed package disagree: ${item.name} (${locked} vs ${item.version})`);
    }
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function tokens(value: string): string[] {
  return [...new Set((value.toLocaleLowerCase("en").match(/[\p{L}\p{N}_./@-]+/gu) ?? []).filter((part) => part.length > 1 && !ignoredWords.has(part)))];
}

function relevance(title: string, body: string, query: string, terms: string[]): number {
  const normalizedTitle = title.toLocaleLowerCase("en");
  const normalizedBody = body.toLocaleLowerCase("en");
  let matched = 0;
  let score = 0;
  for (const term of terms) {
    const inTitle = normalizedTitle.includes(term);
    const inBody = normalizedBody.includes(term);
    if (!inTitle && !inBody) continue;
    matched++;
    score += (inTitle ? 5 : 0) + (inBody ? 1 : 0);
  }
  if (!matched) return 0;
  if (terms.length > 1) score *= matched / terms.length;
  if (normalizedTitle.includes(query)) score += 7;
  else if (normalizedBody.includes(query)) score += 3;
  return score / Math.sqrt(Math.max(1, body.length / 1400));
}

function lineNumber(text: string, offset: number): number {
  let count = 1;
  for (let index = 0; index < offset; index++) if (text[index] === "\n") count++;
  return count;
}

function corpusHits(item: InstalledPackage, query: string, terms: string[]): Hit[] {
  const file = join(item.root, "AGENT_CONTEXT.md");
  const content = readText(file);
  if (!content) {
    if (corpusPackages.has(item.name)) throw new Error(`Missing installed agent corpus: ${item.name}`);
    return [];
  }
  const hits: Hit[] = [];
  const inventories = [...content.matchAll(/<!-- openlup-context-inventory (\[[^\n]*\]) -->\n/gu)];
  if (inventories.length !== 1) throw new Error(`Invalid corpus inventory in ${file}`);
  const inventory: unknown = JSON.parse(inventories[0][1]);
  if (!Array.isArray(inventory) || !inventory.length) throw new Error(`Invalid corpus inventory in ${file}`);
  const sections: unknown[] = [];
  const pattern = /<!-- openlup-context (\{[^\n]*\}) -->\n/g;
  for (const match of content.matchAll(pattern)) {
    const metadata = JSON.parse(match[1]) as { id: string; source: string; heading: string; sha256: string };
    if (!/^[a-z0-9-]+$/u.test(metadata.id) || !/^[\w./-]+\.md$/u.test(metadata.source) || metadata.source.split("/").includes("..")) throw new Error(`Invalid corpus source in ${file}`);
    sections.push(metadata);
    const start = match.index + match[0].length;
    const end = content.indexOf("<!-- /openlup-context -->", start);
    if (end < 0) throw new Error(`Unclosed agent context section in ${file}`);
    const excerpt = content.slice(start, end);
    if (createHash("sha256").update(excerpt).digest("hex") !== metadata.sha256) throw new Error(`Agent context digest mismatch in ${file}: ${metadata.id}`);
    const title = metadata.heading;
    const score = relevance(`${metadata.id} ${title}`, excerpt, query, terms);
    if (score > 0) hits.push({ title, file, start: lineNumber(content, start), end: lineNumber(content, end - 1), owner: metadata.source, packageName: item.name, score, reason: "canonical owner excerpt" });
  }
  if ((content.match(/^<!-- openlup-context(?=\s)/gmu) ?? []).length !== sections.length ||
      (content.match(/^<!-- \/openlup-context(?=\s)/gmu) ?? []).length !== sections.length ||
      JSON.stringify(sections) !== JSON.stringify(inventory) ||
      new Set(sections.map((section) => (section as { id: string }).id)).size !== sections.length) {
    throw new Error(`Invalid corpus inventory or markers in ${file}`);
  }
  return hits;
}

function markdownHits(item: InstalledPackage, fileName: string, query: string, terms: string[]): Hit[] {
  const file = join(item.root, fileName);
  const content = readText(file);
  if (!content) return [];
  const lines = content.split("\n");
  const headings: { index: number; title: string; level: number }[] = [];
  let fence: string | undefined;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/u)?.[1];
    if (fence) { if (marker?.[0] === fence[0] && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/u.test(line)) fence = undefined; continue; }
    if (marker) { fence = marker; continue; }
    const heading = line.match(/^(#{1,6}) (.+)$/u);
    if (heading) headings.push({ index, title: heading[2], level: heading[1].length });
  }
  if (!headings.length) headings.push({ index: 0, title: fileName, level: 1 });
  const hits: Hit[] = [];
  for (const [position, heading] of headings.entries()) {
    const next = headings.slice(position + 1).find((candidate) => candidate.level <= heading.level);
    const endIndex = next?.index ?? lines.length;
    const body = lines.slice(heading.index, endIndex).join("\n");
    const score = relevance(heading.title, body, query, terms);
    if (score > 0) hits.push({ title: heading.title, file, start: heading.index + 1, end: endIndex, packageName: item.name, score, reason: `installed ${fileName}` });
  }
  return hits;
}

function declarationHits(item: InstalledPackage, query: string): Hit[] {
  const exact = /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(query.trim());
  const symbol = query.match(/\b[A-Za-z_$][A-Za-z0-9_$]{2,}\b/gu)?.find((word) =>
    (exact && word === query.trim()) || (/^[a-z_$]/u.test(word) && /[A-Z_]/u.test(word.slice(1))));
  if (!symbol) return [];
  const symbolPattern = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\b`, "u");
  const root = join(item.root, "dist");
  if (!existsSync(root)) return [];
  const hits: Hit[] = [];
  const pending = [root];
  let seen = 0;
  while (pending.length && seen < 1200) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (seen >= 1200) break;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(path);
      else if (entry.isFile() && path.endsWith(".d.ts")) {
        seen++;
        const content = readFileSync(path, "utf8");
        const lines = content.split("\n");
        for (let index = 0; index < lines.length; index++) {
          if (!symbolPattern.test(lines[index])) continue;
          hits.push({ title: symbol, file: path, start: index + 1, end: index + 1, packageName: item.name, score: 20, reason: "exact declaration symbol" });
          break;
        }
      }
    }
  }
  return hits;
}

function exportHits(item: InstalledPackage, query: string, terms: string[]): Hit[] {
  const parsed = JSON.parse(item.manifest) as { exports?: Record<string, unknown> };
  const hits: Hit[] = [];
  for (const subpath of Object.keys(parsed.exports ?? {})) {
    const title = subpath === "." ? item.name : `${item.name}/${subpath.slice(2)}`;
    if (terms.length > 1 && !terms.every((term) => title.toLocaleLowerCase("en").includes(term))) continue;
    const score = relevance(title, title, query, terms);
    const offset = item.manifest.indexOf(JSON.stringify(subpath), item.manifest.indexOf('"exports"'));
    if (score > 0 && offset >= 0) {
      const line = lineNumber(item.manifest, offset);
      hits.push({ title, file: join(item.root, "package.json"), start: line, end: line, packageName: item.name, score: score + 8, reason: "declared public export" });
    }
  }
  return hits;
}

function applicationHits(cwd: string, query: string, terms: string[]): Hit[] {
  const hits: Hit[] = [];
  const pending = [cwd];
  let seen = 0;
  while (pending.length && seen < 2500) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (seen >= 2500) break;
      if (entry.name.startsWith(".") || skippedDirectories.has(entry.name)) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { pending.push(path); continue; }
      if (!entry.isFile() || !codeExtensions.has(entry.name.slice(entry.name.lastIndexOf(".")))) continue;
      if (lstatSync(path).size > 200_000) continue;
      seen++;
      const lines = readFileSync(path, "utf8").split("\n");
      for (let index = 0; index < lines.length; index++) {
        if (!lines[index].includes("@openlup/") && !terms.some((term) => lines[index].toLocaleLowerCase("en").includes(term))) continue;
        const score = relevance(basename(path), lines[index], query, terms);
        if (score > 0) hits.push({ title: relative(cwd, path), file: path, start: index + 1, end: index + 1, packageName: "application", score, reason: "local application source" });
      }
    }
  }
  return hits;
}

export function searchContext(cwd: string, task: string, includeCode = false): { version: string; packages: string[]; hits: Hit[] } {
  const packages = selectedPackages(cwd);
  const query = task.toLocaleLowerCase("en").trim();
  const terms = tokens(task);
  if (!terms.length) throw new Error("Give a specific task, path or symbol to search");
  const hits = packages.flatMap((item) => [
    ...corpusHits(item, query, terms),
    ...markdownHits(item, "AGENTS.md", query, terms),
    ...markdownHits(item, "README.md", query, terms),
    ...(item.name === "@openlup/core" ? markdownHits(item, "docs/SUBSCRIPTION_ENGINE.md", query, terms) : []),
    ...(terms.some((term) => /upgrad|migrat|release|wersj/u.test(term)) ? markdownHits(item, "CHANGELOG.md", query, terms) : []),
    ...declarationHits(item, task),
    ...exportHits(item, query, terms),
  ]);
  if (includeCode) hits.push(...applicationHits(cwd, query, terms));
  hits.sort((left, right) => right.score - left.score || left.file.localeCompare(right.file) || left.start - right.start);
  const unique = new Set<string>();
  const selected = hits.filter((hit) => { const key = `${hit.file}:${hit.start}:${hit.end}`; if (unique.has(key)) return false; unique.add(key); return true; }).slice(0, 8);
  return { version: packages[0].version, packages: packages.map((item) => item.name), hits: selected };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) { process.stdout.write(usage); return; }
  if (args[0] !== "search") throw new Error(usage.trim());
  const json = args.includes("--json");
  const code = args.includes("--code");
  const task = args.slice(1).filter((arg) => !arg.startsWith("--")).join(" ").trim();
  const result = searchContext(process.cwd(), task, code);
  if (json) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  process.stdout.write(`OpenLup ${result.version}: ${result.packages.join(", ")}\n`);
  if (!result.hits.length) { process.stdout.write("No indexed match. This does not prove a public seam is absent; inspect installed exports and declarations.\n"); return; }
  for (const [index, hit] of result.hits.entries()) {
    const path = relative(process.cwd(), hit.file);
    process.stdout.write(`${index + 1}. ${hit.title} [${hit.packageName}]\n   ${path}:${hit.start}-${hit.end} (${hit.reason})${hit.owner ? `; source ${hit.owner}` : ""}\n`);
  }
}

export function runCli(): void {
  try { main(); }
  catch (error) { process.stderr.write(`openlup-context: ${(error as Error).message}\n`); process.exitCode = 1; }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runCli();
