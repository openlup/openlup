import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import * as contracts from "../../src/communications/contracts/index.js";
import type { AuthEmailContentPort, EmailBrand, NewsletterSyncProviderPort, TransactionalDeliveryReceiptStore } from "../../src/communications/contracts/index.js";

it("exposes type-only rendering, delivery and newsletter ports without loading a server runtime", () => {
  const types: [AuthEmailContentPort?, EmailBrand?, NewsletterSyncProviderPort?, TransactionalDeliveryReceiptStore?] = [];
  expect(types).toEqual([]);
  expect(Object.keys(contracts)).toEqual([]);
  const entry = fileURLToPath(new URL("../../src/communications/contracts/index.ts", import.meta.url));
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true,
    types: [], lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  });
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
}, 30_000);
