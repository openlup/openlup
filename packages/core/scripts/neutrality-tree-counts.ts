// A process boundary lets repository tooling reuse the scanner without importing
// package internals or making the core depend on another workspace package.
import { readFileSync } from "node:fs";
import { scanNeutralitySource, type SourceNeutralityPolicy } from "./neutrality-source-scanner.ts";

const input = JSON.parse(readFileSync(0, "utf8")) as { sources: { path: string; contents: string }[]; policy: SourceNeutralityPolicy };
console.log(JSON.stringify(input.sources.map(({ path, contents }) => ({ path, counts: scanNeutralitySource(contents, input.policy, { shell: path.endsWith(".sh") }) }))));
