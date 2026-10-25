import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export const repositoryRoot = fileURLToPath(new URL("../../../../", import.meta.url));
export const readRepository = (path: string) => readFileSync(resolve(repositoryRoot, path), "utf8");
/** Follow the latest actual definition in the baseline plus ordered forwards. */
export function effectiveFunctionBody(name: string): string {
  const files = readdirSync(resolve(repositoryRoot, "supabase/migrations")).filter(file => file.endsWith(".sql")).sort();
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const definition = new RegExp(`^[ \\t]*CREATE\\s+(?:OR\\s+REPLACE\\s+)?FUNCTION\\s+(?:public\\.)?${escaped}\\s*\\(`, "im");
  const drop = new RegExp(`^[ \\t]*DROP\\s+FUNCTION\\s+(?:IF\\s+EXISTS\\s+)?(?:public\\.)?${escaped}\\b`, "im");
  let result = "";
  for (const file of files) {
    const source = readRepository(`supabase/migrations/${file}`), start = source.search(definition);
    if (start < 0) { if (drop.test(source)) result = ""; continue; }
    const rest = source.slice(start), opener = /\bAS\s+\$(\w*)\$/.exec(rest);
    if (!opener) throw new Error(`no function body: ${name}`);
    const tag = `$${opener[1]}$`, end = rest.indexOf(tag, opener.index + opener[0].length);
    if (end < 0) throw new Error(`unterminated function: ${name}`);
    result = rest.slice(0, rest.indexOf(";", end + tag.length) + 1);
  }
  if (!result) throw new Error(`no effective definition: ${name}`);
  return result;
}
