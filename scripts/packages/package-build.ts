/** Shared single-package preparation for preflight and the tag publisher. */
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { type PackageEntry } from "./package-manifest-policy.ts";

type Manifest = { files?: string[]; scripts?: Record<string, string>; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
const fields = ["dependencies", "peerDependencies", "optionalDependencies"] as const;
const git = (root: string, args: string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });

/** Build declared internal prerequisites first; cold attempts cannot inherit another pack's dist. */
export function preparePackage(root: string, selected: PackageEntry, packages: readonly PackageEntry[], cold: boolean): void {
  if (cold) for (const entry of packages) {
    let path = root;
    for (const component of entry.directory.split("/")) {
      path = join(path, component);
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`package-build: ${entry.directory} has a symlink in its package path`);
    }
    if (git(root, ["status", "--porcelain", "--untracked-files=no", "--", entry.directory]).trim()) throw new Error(`package-build: ${entry.directory} has uncommitted cold cleanup changes`);
  }
  const entries = new Map(packages.map((entry) => [entry.name, entry]));
  const manifests = new Map(packages.map((entry) => [entry.name, JSON.parse(readFileSync(join(root, entry.directory, "package.json"), "utf8")) as Manifest]));
  const order: PackageEntry[] = [], visiting = new Set<string>(), built = new Set<string>();
  const visit = (entry: PackageEntry): void => {
    if (visiting.has(entry.name)) throw new Error(`package-build: internal dependency cycle at ${entry.name}`);
    if (built.has(entry.name)) return;
    visiting.add(entry.name);
    for (const field of fields) for (const name of Object.keys(manifests.get(entry.name)![field] ?? {})) {
      if (!name.startsWith("@openlup/")) continue;
      const dependency = entries.get(name);
      if (!dependency || (entry.publish && !dependency.publish)) throw new Error(`package-build: ${entry.name} requires unavailable publishable prerequisite ${name}`);
      visit(dependency);
    }
    visiting.delete(entry.name); built.add(entry.name); order.push(entry);
  };
  visit(selected);
  for (const entry of order) if (git(root, ["status", "--porcelain", "--untracked-files=no", "--", entry.directory]).trim()) throw new Error(`package-build: ${entry.directory} has uncommitted prerequisite changes`);
  if (cold) {
    // The portable package build output is dist/. Refuse another layout instead of claiming a cold proof.
    for (const entry of packages) {
      const output = `${entry.directory}/dist`, path = join(root, output);
      if (entry.publish && !manifests.get(entry.name)!.files?.includes("dist/**")) throw new Error(`package-build: ${entry.name} has no declared dist/** cold build output`);
      if (git(root, ["ls-files", "--", output]).trim()) throw new Error(`package-build: ${output} contains tracked files; cold preparation refuses to delete them`);
      if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`package-build: ${output} is a symlink`);
    }
    for (const entry of packages) rmSync(join(root, entry.directory, "dist"), { recursive: true, force: true });
  }
  for (const entry of order) {
    const scripts = manifests.get(entry.name)!.scripts ?? {};
    const prepare = "prepack" in scripts ? "prepack" : "build" in scripts ? "build" : undefined;
    if (prepare) execFileSync("npm", ["run", prepare], { cwd: join(root, entry.directory), stdio: ["ignore", "inherit", "inherit"] });
    if (git(root, ["status", "--porcelain", "--untracked-files=no", "--", entry.directory]).trim()) throw new Error(`package-build: the build rewrote tracked files under ${entry.directory}`);
  }
}
