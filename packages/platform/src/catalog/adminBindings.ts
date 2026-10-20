import type { ZodType } from "zod";
import type { HttpRequest, HttpResponse } from "../http/index.js";

/** Structural inputs to the reference admin kit. Authorization and parsing stay with the host. */
export type AuthorizeAdmin = () => Promise<
  | { ok: true; userId: string; role: "admin" | "distributor"; isMachineActor: boolean }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string; identityCode?: string }
>;
export interface AgentDomainQuerySpec<T> {
  readonly key: string;
  readonly requestSchema: ZodType<T, unknown>;
  readonly gate: "read";
  readonly allowedActorKinds: readonly ("human" | "machine")[];
}
export interface AgentDomainMutationSpec<T> extends Omit<AgentDomainQuerySpec<T>, "gate"> {
  readonly gate: "mutation" | "activation";
  readonly lifecycleMarkers: readonly ("LIFECYCLE_ACTIVATE" | "LIFECYCLE_DEACTIVATE" | "HARD_DELETE")[];
}
export type BundleMutationKey = "create" | "update" | "setComposition" | "setTargetPrice" | "archive" | "restore" | "cloneDraft" | "activate" | "deactivate";
export type BundleQueryKey = "list" | "get" | "history" | "previewPrice";
export interface BundleResponseSchema {
  safeParse(value: unknown): { success: boolean; data?: unknown };
}
type Handler = (req: HttpRequest, res: HttpResponse) => Promise<void>;
interface CommonOptions<T> {
  authorizeAdmin: AuthorizeAdmin;
  flagName?: string;
  enabled?: boolean;
  toResponse(value: T): Record<string, unknown>;
  disabledMessage?: string;
  invalidRequestMessage: string;
  failureMessage: string;
}
export interface BundleAdminBindings {
  bundleSpec: {
    readonly mutations: Readonly<Record<string, AgentDomainMutationSpec<unknown>>>;
    readonly queries?: Readonly<Record<string, AgentDomainQuerySpec<unknown>>>;
    readonly mutationFlag: `${string}_MUTATIONS_ENABLED`;
    readonly activationFlag: `${string}_ACTIVATION_ENABLED`;
    readonly readFlag?: `${string}_READ_ENABLED`;
  };
  COMMERCE_CONTRACT_VERSION: "commerce.v0";
  /** Passed by identity: instanceof and shared SQLSTATE mapping retain their owner. */
  BundleRpcError: new (sqlstate: string | undefined, message: string) => Error & { sqlstate: string | undefined; pgMessage: string };
  createAdminMutationHandler<Request, Result>(options: CommonOptions<Result> & {
    mutation: AgentDomainMutationSpec<Request>;
    invoke(actorId: string, request: Request): Promise<Result>;
  }): Handler;
  createAdminParameterizedReadHandler<Request, Result>(options: CommonOptions<Result> & {
    query: AgentDomainQuerySpec<Request>;
    load(actorId: string, request: Request): Promise<Result>;
    responseSchema: BundleResponseSchema;
    invalidResponseMessage: string;
  }): Handler;
  bundleHistoryResponseSchema: BundleResponseSchema;
  getBundleResponseSchema: BundleResponseSchema;
  listBundlesResponseSchema: BundleResponseSchema;
  previewBundlePriceResponseSchema: BundleResponseSchema;
}
