// Every Docker removal in a tracked shell or Node script must remove anonymous volumes.
//
// The local proof and parity scripts start a `postgres:16` container. That image
// declares `VOLUME /var/lib/postgresql/data`, so every start mints an anonymous
// volume, and `docker rm -f "$container"` removes the container while leaving the
// volume behind. `docker run --rm` does not rescue it: the force-remove wins the
// race against the daemon's auto-remove, and the volume is orphaned either way.
// Measured on 2026-09-09: 1571 idle anonymous volumes, 99.9 GB, about 160 a day.
//
// `-v` removes only anonymous volumes; named volumes are never touched, so the
// flag is always safe to carry and the rule needs no allow-list.
//
// The scan is measured on its own failure modes below: a fixture that must go
// red, the flag spellings that must stay green, and a floor on how many real
// invocations the repository scan actually saw, so a regex that matches nothing
// cannot pass this file.
//
// The repository is read through `git grep` and `git ls-files` rather than the
// filesystem: only tracked scripts count, and the file opens no path it computed,
// so it stays out of the opaque-dependency-edge registry.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const ROOT = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();


/** `docker rm` or `docker container rm`, followed by its option words. */
const DOCKER_RM = /\bdocker\s+(?:container\s+)?rm\b((?:\s+--?[A-Za-z][\w-]*(?:=\S*)?)*)/g;

export type Invocation = { line: number; text: string; volumes: boolean };

/** Whether one option cluster (`-fv`, `--volumes`, `-v`) carries the volume flag. */
function carriesVolumeFlag(option: string): boolean {
  if (option === "--volumes") return true;
  if (option.startsWith("--")) return false;
  return option.slice(1).includes("v");
}

/** Every `docker rm` invocation in a shell source, with whether it removes volumes. */
export function dockerRmInvocations(source: string, firstLine = 1): Invocation[] {
  const found: Invocation[] = [];
  source.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trimStart().startsWith("#")) return;
    for (const match of raw.matchAll(DOCKER_RM)) {
      const options = match[1].trim().split(/\s+/).filter(Boolean);
      found.push({ line: firstLine + index, text: raw.trim(), volumes: options.some(carriesVolumeFlag) });
    }
  });
  return found;
}

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8" });
}

function trackedScripts(): string[] {
  return git(["ls-files", "-z", "--", "scripts/"]).split("\0")
    .filter((file) => /\.(?:sh|ts|mjs|cjs|js)$/.test(file) && !/\.(?:test|spec)\./.test(file)).sort();
}

/** Node argv is code, so read literal Docker invocations through the TS AST. */
export function nodeDockerRmInvocations(source: string): Invocation[] {
  const file = ts.createSourceFile("script.ts", source, ts.ScriptTarget.Latest, true);
  const found: Invocation[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const [command, argumentsNode] = node.arguments;
      if (command && ts.isStringLiteral(command) && command.text === "docker" && argumentsNode && ts.isArrayLiteralExpression(argumentsNode)) {
        const words = argumentsNode.elements.map((element) => ts.isStringLiteral(element) ? element.text : null);
        const offset = words[0] === "rm" ? 1 : words[0] === "container" && words[1] === "rm" ? 2 : null;
        if (offset !== null) {
          const line = file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
          found.push({ line, text: node.getText(file), volumes: words.slice(offset).some((word) => word !== null && word.startsWith("-") && carriesVolumeFlag(word)) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return found;
}

describe("docker rm carries -v in every tracked runtime script under scripts/", () => {
  it("flags a force-remove that leaves the anonymous volume behind", () => {
    const fixture = [
      "#!/usr/bin/env bash",
      "cleanup() { docker rm -f \"$container\" >/dev/null 2>&1 || true; }",
      "trap 'docker rm --force \"$container\" >/dev/null' EXIT",
      "docker rm \"$container\"",
      "docker container rm -f \"$container\"",
    ].join("\n");
    const leaking = dockerRmInvocations(fixture).filter((invocation) => !invocation.volumes);
    expect(leaking.map((invocation) => invocation.line)).toEqual([2, 3, 4, 5]);
  });

  it("accepts every spelling that removes the volume, and ignores comments and `docker run --rm`", () => {
    const fixture = [
      "# docker rm -f \"$container\" is documented here only",
      "docker run --detach --rm --name \"$container\" postgres:16",
      "docker rm -f -v \"$container\" >/dev/null",
      "docker rm -fv \"$container\"",
      "docker rm -vf \"$container\"",
      "docker rm -v -f \"$container\"",
      "docker rm --volumes --force \"$container\"",
      "trap 'docker rm -f -v \"$container\" >/dev/null' EXIT",
    ].join("\n");
    const invocations = dockerRmInvocations(fixture);
    expect(invocations).toHaveLength(6);
    expect(invocations.every((invocation) => invocation.volumes)).toBe(true);
  });

  it("detects Node argv removals and ignores documented or run-only examples", () => {
    const fixture = `// exec("docker", ["rm", "-f", name]);
      exec("docker", ["rm", "-f", name]);
      exec("docker", ["rm", "-fv", name]);
      exec("docker", ["container", "rm", "--volumes", name]);
      exec("docker", ["run", "--rm", name]);`;
    expect(nodeDockerRmInvocations(fixture).map(({ volumes }) => volumes)).toEqual([false, true, true]);
  });

  it("finds no tracked shell or Node runtime removing a container without volumes", () => {
    const files = trackedScripts();
    expect(files).toContain("scripts/customer-diagnostic-neutrality-proof.ts");
    const seen: string[] = [];
    const leaking: string[] = [];
    for (const path of files) {
      const source = readFileSync(join(ROOT, path), "utf8");
      const invocations = path.endsWith(".sh") ? dockerRmInvocations(source) : nodeDockerRmInvocations(source);
      for (const invocation of invocations) {
        seen.push(path);
        if (!invocation.volumes) leaking.push(`${path}:${invocation.line}: ${invocation.text}`);
      }
    }
    // This published cleanup is real; an extractor that loses it must fail.
    expect(seen).toContain("scripts/customer-diagnostic-neutrality-proof.ts");
    expect(leaking, "container removals must also remove anonymous volumes").toEqual([]);
  });
});
