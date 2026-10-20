import type { z } from "zod";
import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { BffResponder } from "../bff/index.js";
import type { createPromotionCodePreview } from "./promotionCodePreview.js";

/** Structural inputs to the existing host admin kit; no kit implementation lives here. */
export type AdminAuthorization =
  | { ok: true; userId: string; role: "admin" | "distributor"; isMachineActor: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string; identityCode?: string };
export type AuthorizeAdmin = () => Promise<AdminAuthorization>;
export interface AgentDomainQuerySpec<T> {
  readonly key: string;
  readonly requestSchema: z.ZodType<T, unknown>;
  readonly gate: "read";
  readonly allowedActorKinds: readonly ("human" | "machine")[];
}
export interface AgentDomainMutationSpec<T> extends Omit<AgentDomainQuerySpec<T>, "gate"> {
  readonly gate: "mutation";
  readonly lifecycleMarkers: readonly never[];
}
type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void>;
type ErrorMapper = (res: HttpResponse, error: unknown, failureMessage: string) => void;
interface ReadOptions<T> {
  readonly authorizeAdmin: AuthorizeAdmin;
  readonly toResponse: (value: T) => Record<string, unknown>;
  readonly responseSchema: { safeParse(value: unknown): { success: boolean; data?: unknown } };
  readonly invalidResponseMessage: string;
  readonly failureMessage: string;
}
interface MutationOptions<Request, Result> extends Omit<ReadOptions<Result>, "responseSchema" | "invalidResponseMessage"> {
  readonly mutation: AgentDomainMutationSpec<Request>;
  readonly invoke: (actorId: string, request: Request) => Promise<Result>;
  readonly responseSchema?: ReadOptions<Result>["responseSchema"];
  readonly invalidResponseMessage?: string;
  readonly invalidRequestMessage: string;
  readonly mapError?: ErrorMapper;
}
interface QueryOptions<Request, Result> extends ReadOptions<Result> {
  readonly query: AgentDomainQuerySpec<Request>;
  readonly load: (actorId: string, request: Request) => Promise<Result>;
  readonly invalidRequestMessage: string;
  readonly mapError?: ErrorMapper;
}
export interface PromotionAdminBindings extends BffResponder, Pick<ReturnType<typeof createPromotionCodePreview>,
  "generatePromotionCode" | "normalizePromotionCode" | "previewPromotionCode" | "verifyPromotionPreviewProof"> {
  createAdminMutationHandler<Request, Result>(options: MutationOptions<Request, Result>): Handler;
  createAdminReadHandler<Result>(options: ReadOptions<Result> & { load(): Promise<Result> }): Handler;
  createAdminParameterizedReadHandler<Request, Result>(options: QueryOptions<Request, Result>): Handler;
  mapRpcError: ErrorMapper;
  resolveAdmin(authorize: AuthorizeAdmin, res: HttpResponse): Promise<Omit<Extract<AdminAuthorization, { ok: true }>, "ok"> | null>;
  /** The host constructor is passed by identity, preserving instanceof and SQLSTATE mapping. */
  DomainRpcError: new (sqlstate: string | undefined, pgMessage: string) => Error & { sqlstate: string | undefined; pgMessage: string };
}
