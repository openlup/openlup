import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = process.cwd();

const hardenedBffRoots = [
  "server/bff/admin/accounting",
  "server/bff/admin/communications",
  "server/bff/admin/inventory",
  "server/bff/admin/risk",
  "server/bff/admin/returns",
];

const hardenedBffFiles = [
  "server/bff/admin/clients/governance.ts",
  "server/bff/communications/preferences.ts",
];

describe("admin BFF service-role boundary", () => {
  it("keeps remaining direct service-role client construction isolated to commerce BFF routes", () => {
    const offenders = sourceFiles("server/bff")
      .filter((file) => read(file).includes("createServiceRoleClient("))
      .map(relative)
      .filter((file) => !file.startsWith("server/bff/admin/commerce/"));

    expect(offenders).toEqual([]);
  });

  it("keeps consolidated non-commerce BFF routes behind domain gateways", () => {
    const offenders = hardenedBffRoots
      .flatMap(sourceFiles)
      .concat(hardenedBffFiles.map((file) => join(repoRoot, file)))
      .filter((file) => existsSync(file))
      .filter((file) => !file.endsWith(".test.ts"))
      .filter((file) => {
        const source = read(file);
        return source.includes("createServiceRoleClient(") ||
          /from\s+["'][^"']*domains\/[^"']*\/(?:supabase|adminEmailSends)[^"']*Port\.js["']/.test(source) ||
          /\.(?:from|rpc|storage)\b/.test(source);
      })
      .map(relative);

    expect(offenders).toEqual([]);
  });
});

function sourceFiles(path: string): string[] {
  const absolute = join(repoRoot, path);
  if (!existsSync(absolute)) return [];
  const stat = statSync(absolute);
  if (stat.isFile()) return absolute.endsWith(".ts") ? [absolute] : [];
  return readdirSync(absolute)
    .flatMap((entry) => sourceFiles(join(path, entry)));
}

function read(file: string): string {
  return readFileSync(file, "utf8");
}

function relative(file: string): string {
  return file.startsWith(`${repoRoot}/`) ? file.slice(repoRoot.length + 1) : file;
}
