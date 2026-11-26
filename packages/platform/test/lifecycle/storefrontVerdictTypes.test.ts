import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";

// The probe sits beside this test (an in-memory file at that path) and imports the
// exported type and the internal schema module from source.
const probe = `import type { z } from "zod";
import type { StorefrontFindingCode, StorefrontVerdict } from "../../src/lifecycle/storefrontVerdict.js";
import type { StorefrontProofFile } from "../../src/lifecycle/storefrontProofFile.js";
import type * as schema from "../../src/lifecycle/storefrontVerdictSchema.js";
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
// Drops the index signature a loose object adds and the undefined zod adds to an optional field.
type NamedKeys<T> = keyof { [K in keyof T as string extends K ? never : number extends K ? never : K]: 0 };
// A loose object's index signature is dropped; a pure record (no named key) is kept as it is.
type Declared<T> = T extends string | number | boolean | null ? T : T extends readonly (infer E)[] ? Declared<E>[] : T extends object ? ([NamedKeys<T>] extends [never] ? T : { [K in keyof T as string extends K ? (unknown extends T[K] ? never : K) : K]: Declared<Exclude<T[K], undefined>> }) : T;
type Known<T> = T extends string ? (string extends T ? never : T) : never;
type Verdict = StorefrontVerdict;
type Step = Verdict["steps"][number];
const shape: Equals<Declared<z.output<typeof schema.verdictSchema>>, Verdict> = true;
const tiers: Equals<Known<Verdict["tier"]>, (typeof schema.knownTiers)[number]> = true;
const channels: Equals<Known<Verdict["channel"]>, (typeof schema.knownChannels)[number]> = true;
const results: Equals<Known<Verdict["result"]>, (typeof schema.knownResults)[number]> = true;
const phases: Equals<Known<Step["phase"]>, (typeof schema.knownPhases)[number]> = true;
const runs: Equals<Known<Step["run"]>, (typeof schema.knownRuns)[number]> = true;
const findingRuns: Equals<Known<Verdict["findings"][number]["run"]>, (typeof schema.knownRuns)[number]> = true;
const controls: Equals<Known<Verdict["control"]["kind"]>, (typeof schema.knownControlKinds)[number]> = true;
const sources: Equals<Known<Verdict["build"]["source"]>, (typeof schema.knownBuildSources)[number]> = true;
const adapters: Equals<Known<Verdict["harness"]["adapter"]["kind"]>, (typeof schema.knownAdapterKinds)[number]> = true;
const observers: Equals<Known<Verdict["harness"]["observer"]>, (typeof schema.knownObserverKinds)[number]> = true;
const codes: Equals<Known<StorefrontFindingCode>, (typeof schema.knownFindingCodes)[number]> = true;
const openCode: StorefrontFindingCode = "code_added_later";
const proofShape: Equals<Declared<z.output<typeof schema.proofFileSchema>>, StorefrontProofFile> = true;
const policies: Equals<Known<Exclude<StorefrontProofFile["changedPayloadPolicy"], undefined>>, (typeof schema.knownChangedPayloadPolicies)[number]> = true;
const proofMissingOptional: Equals<Declared<z.output<typeof schema.proofFileSchema>>, Omit<StorefrontProofFile, "recheck">> = false;
// Negative controls of the probe itself: a missing optional field and a dropped open set fail.
const missingOptional: Equals<Declared<z.output<typeof schema.verdictSchema>>, Omit<Verdict, "width">> = false;
const closedResult: Equals<Declared<z.output<typeof schema.verdictSchema>>, Omit<Verdict, "result"> & { result: Known<Verdict["result"]> }> = false;
export { shape, tiers, channels, results, phases, runs, findingRuns, controls, sources, adapters, observers, codes, openCode, proofShape, policies, proofMissingOptional, missingOptional, closedResult };
`;

it("V9 and P10 keep StorefrontVerdict and StorefrontProofFile exactly equal to the internal schemas and their open-set members", () => {
  const filename = fileURLToPath(new URL("./storefront-verdict-types-virtual.mts", import.meta.url));
  const options: ts.CompilerOptions = {
    strict: true, exactOptionalPropertyTypes: true, noEmit: true, noUnusedLocals: false, target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, types: [],
    lib: ["lib.es2022.d.ts", "lib.dom.d.ts"], skipLibCheck: true,
  };
  const host = ts.createCompilerHost(options);
  const read = host.readFile.bind(host), exists = host.fileExists.bind(host);
  host.readFile = path => path === filename ? probe : read(path);
  host.fileExists = path => path === filename || exists(path);
  const diagnostics = ts.getPreEmitDiagnostics(ts.createProgram([filename], options, host))
    .filter(diagnostic => diagnostic.file?.fileName === filename)
    .map(diagnostic => `${diagnostic.file!.getLineAndCharacterOfPosition(diagnostic.start!).line + 1}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`);
  expect(diagnostics).toEqual([]);
}, 60_000);
