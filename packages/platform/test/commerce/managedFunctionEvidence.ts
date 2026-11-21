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
  let provider = "";
  for (const file of files) {
    const source = readRepository(`supabase/migrations/${file}`);
    const found = /stock\.provider_kind='([^']+)'/.exec(source);
    if (found) provider = found[1];
    const start = source.search(definition);
    if (start < 0) { if (drop.test(source)) result = ""; continue; }
    const rest = source.slice(start), opener = /\bAS\s+\$(\w*)\$/.exec(rest);
    if (!opener) throw new Error(`no function body: ${name}`);
    const tag = `$${opener[1]}$`, end = rest.indexOf(tag, opener.index + opener[0].length);
    if (end < 0) throw new Error(`unterminated function: ${name}`);
    const body = rest.slice(0, rest.indexOf(";", end + tag.length) + 1);
    const tailMatch = /\bv_common_tail\s*:=\s*format\(\$tail\$([\s\S]*?)\$tail\$/m.exec(source);
    if (tailMatch && body.includes("%s")) {
      const tailArgs = [
        `${provider}_dispatch_refs`,
        `${provider}_status_evidence`,
        `'${provider}_dispatch_failed'`,
        `'${provider}_picked_not_shipped'`,
        `'${provider}_dispatched_not_picked'`,
        `'${provider}_dispatched_not_picked'`,
        `'${provider}DispatchedNotPicked'`,
      ];
      let idx = 0;
      const tail = tailMatch[1].replace(/%[IL]/g, () => tailArgs[idx++] ?? "");
      result = body.replace(/%s/g, () => tail).replace(/%I/g, `${provider}_dispatch_refs`).replace(/%%/g, "%");
    } else {
      result = body;
    }
  }
  if (!result) throw new Error(`no effective definition: ${name}`);
  return result;
}
