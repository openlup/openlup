import { describe, expect, it } from "vitest";
import ts from "typescript";
import { fileURLToPath } from "node:url";
import type {
  AcquisitionCaseListResponse as BaseAcquisitionCaseListResponse,
  AcquisitionCaseProjection as BaseAcquisitionCaseProjection,
  AcquisitionCaseSubmitRequest as BaseAcquisitionCaseSubmitRequest,
  AcquisitionCaseTransitionRequest as BaseAcquisitionCaseTransitionRequest,
} from "../../../src/domains/clients/acquisitionCaseContracts.js";

import type {
  AcquisitionCasePort,
  AcquisitionCaseResult,
} from "./acquisitionCasePorts.js";

describe("acquisition case port", () => {
  it("exposes capability-local operations and tagged failures", () => {
    const failure = { ok: false, error: { kind: "rate_limited" } } satisfies AcquisitionCaseResult<number>;
    const port = {
      submit: async () => failure,
      list: async () => failure,
      get: async () => failure,
      transition: async () => failure,
      activeCount: async () => ({ ok: true as const, value: 0 }),
      close: async () => undefined,
    } satisfies AcquisitionCasePort;
    expect(Object.keys(port).sort()).toEqual(["activeCount", "close", "get", "list", "submit", "transition"]);
    expect(failure.error.kind).toBe("rate_limited");
  });
});

// Base-equivalent shape captured from the pinned source before extraction.
export type BaseAcquisitionCaseFailureKind =
  | "conflict"
  | "invalid"
  | "not_found"
  | "rate_limited"
  | "unavailable";

export type BaseAcquisitionCaseResult<T> =
  | { ok: true; value: T; replayed?: boolean }
  | { ok: false; error: { kind: BaseAcquisitionCaseFailureKind } };

export interface BaseAcquisitionCaseSubmitCommand {
  scope: "public_tester_application";
  sourceKind: "tester_application";
  idempotencyKey: string;
  requesterKey: string;
  acceptedAt: string;
  sourcePath: "/tester-application";
  request: BaseAcquisitionCaseSubmitRequest;
}

export interface BaseAcquisitionCaseListQuery {
  actorRef: string;
  scope: "public_tester_application";
  cursor?: string;
  limit: number;
}

export interface BaseAcquisitionCaseGetQuery {
  actorRef: string;
  scope: "public_tester_application";
  caseRef: string;
}

export interface BaseAcquisitionCaseTransitionCommand {
  actorRef: string;
  scope: "public_tester_application";
  idempotencyKey: string;
  request: BaseAcquisitionCaseTransitionRequest;
}

export interface BaseAcquisitionCasePort {
  submit(command: BaseAcquisitionCaseSubmitCommand): Promise<BaseAcquisitionCaseResult<BaseAcquisitionCaseProjection>>;
  list(query: BaseAcquisitionCaseListQuery): Promise<BaseAcquisitionCaseResult<BaseAcquisitionCaseListResponse>>;
  get(query: BaseAcquisitionCaseGetQuery): Promise<BaseAcquisitionCaseResult<BaseAcquisitionCaseProjection>>;
  transition(command: BaseAcquisitionCaseTransitionCommand): Promise<BaseAcquisitionCaseResult<BaseAcquisitionCaseProjection>>;
  activeCount(scope: "public_tester_application"): Promise<BaseAcquisitionCaseResult<number>>;
  close(): Promise<void>;
}

type Assert<T extends true> = T;
export type ReferenceCasePortFit = [
  Assert<AcquisitionCasePort extends BaseAcquisitionCasePort ? true : false>,
  Assert<BaseAcquisitionCasePort extends AcquisitionCasePort ? true : false>,
];
it("compiles reference port assignability both ways against the base-equivalent shape", () => {
  const program = ts.createProgram([fileURLToPath(import.meta.url)], {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
    strict: true, skipLibCheck: true, noEmit: true, esModuleInterop: true, types: ["node"],
  });
  expect(ts.formatDiagnosticsWithColorAndContext(ts.getPreEmitDiagnostics(program), {
    getCanonicalFileName: path => path, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  })).toBe("");
}, 30_000);
