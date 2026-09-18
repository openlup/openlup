import type { CompositionRulesPort } from "@openlup/core/bundle";

import { COMMERCE_CONTRACT_VERSION } from "../../../src/domains/commerce/types.js";
import type {
  CreateBundleDraftRequest,
  SetBundleCompositionRequest,
  SetBundleTargetPriceRequest,
  UpdateBundleDraftRequest,
} from "../../../src/domains/bundle/adminBundleContracts.js";
import type {
  ActivateBundleRequest,
  ArchiveBundleRequest,
  CloneBundleDraftRequest,
  DeactivateBundleRequest,
  RestoreBundleRequest,
} from "../../../src/domains/bundle/adminBundleLifecycleContracts.js";
import {
  bundleSpec,
  BUNDLE_ACTIVATION_FLAG,
  BUNDLE_MUTATION_FLAG,
  type BundleMutationKey,
} from "../../../src/domains/bundle/bundleSpec.js";
import {
  evaluateBundleComposition,
  evaluateBundleCompositionConstraint,
  evaluateBundleFulfillmentMode,
} from "../../../src/domains/bundle/bundleRules.js";
import type { AgentDomainMutationSpec } from "../../../src/lib/agent-domain/domainSpec.js";
import { createAdminMutationHandler } from "../../_lib/admin-domain/handlers.js";
import type { AuthorizeAdmin } from "../../_lib/admin-domain/auth.js";
import {
  BundleRpcError,
  type AdminBundleWritePort,
  type BundleWriteResult,
} from "./adminBundleWritePort.js";

/**
 * Bundle write handlers — each is the generic kit factory
 * `createAdminMutationHandler` driven by one operation of `bundleSpec`. The
 * factory owns the shared spine (POST-only, flag gate, admin authz, DB-derived
 * actor-kind gate, contract parse, error map, success envelope); this module only
 * injects the request-scoped port call, the envelope shape and the two pure rule
 * passes that are decidable before the write.
 */

export { BUNDLE_ACTIVATION_FLAG, BUNDLE_MUTATION_FLAG };

const BUNDLE_DISABLED = "Bundle writes are disabled";
const BUNDLE_INVALID = "Invalid bundle write request";
const BUNDLE_FAILURE = "Bundle write failed";

/** Bundle success envelope; only the fields the operation actually produced. */
function bundleResponse(result: BundleWriteResult): Record<string, unknown> {
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    dryRun: result.dryRun,
    idempotent: result.idempotent,
    ...(result.code ? { code: result.code } : {}),
    ...(result.bundleId ? { bundleId: result.bundleId } : {}),
    ...(result.componentCount === undefined ? {} : { componentCount: result.componentCount }),
  };
}

export interface AdminBundleHandlerDeps {
  writePort: AdminBundleWritePort;
  authorizeAdmin: AuthorizeAdmin;
  mutationsEnabled: boolean;
  activationEnabled: boolean;
  /**
   * The adopter's composition rules. Supplied only where a composition constraint
   * can be attached; when absent, a non-empty envelope is stored unvalidated, which
   * is what "the platform never interprets it" means.
   */
  compositionRules?: CompositionRulesPort;
}

/** A request-layer rule refusal, mapped onto the same envelope the boundary uses. */
function ruleRefusal(violations: readonly string[]): BundleRpcError {
  return new BundleRpcError("P0001", violations.join(","));
}

function buildBundleHandler<TReq>(
  deps: AdminBundleHandlerDeps,
  mutationKey: BundleMutationKey,
  invoke: (port: AdminBundleWritePort, actorId: string, input: TReq) => Promise<BundleWriteResult>,
) {
  const mutation = bundleSpec.mutations[mutationKey] as AgentDomainMutationSpec<TReq>;
  const isActivation = mutation.gate === "activation";
  return createAdminMutationHandler<TReq, BundleWriteResult>({
    mutation,
    flagName: isActivation ? bundleSpec.activationFlag : bundleSpec.mutationFlag,
    enabled: isActivation ? deps.activationEnabled : deps.mutationsEnabled,
    authorizeAdmin: deps.authorizeAdmin,
    invoke: (actorId, input) => invoke(deps.writePort, actorId, input),
    toResponse: bundleResponse,
    disabledMessage: BUNDLE_DISABLED,
    invalidRequestMessage: BUNDLE_INVALID,
    failureMessage: BUNDLE_FAILURE,
  });
}

export function createAdminBundleCreateDraftHandler(deps: AdminBundleHandlerDeps) {
  return buildBundleHandler<CreateBundleDraftRequest>(deps, "create", (port, actorId, input) => {
    const mode = evaluateBundleFulfillmentMode(input.bundle.fulfillmentMode);
    if (!mode.ok) return Promise.reject(ruleRefusal(mode.violations));
    return port.upsertDraft(actorId, input);
  });
}

export function createAdminBundleUpdateDraftHandler(deps: AdminBundleHandlerDeps) {
  return buildBundleHandler<UpdateBundleDraftRequest>(deps, "update", (port, actorId, input) => {
    const requested = input.updates.fulfillmentMode;
    if (requested !== undefined) {
      const mode = evaluateBundleFulfillmentMode(requested);
      if (!mode.ok) return Promise.reject(ruleRefusal(mode.violations));
    }
    return port.updateDraft(actorId, input);
  });
}

/**
 * Whole-set composition replace. Two pure passes run before the write: the set
 * rules that are decidable from the request alone (at least one component, at
 * least one non-add-on, no unit twice), and — when the bundle carries a non-empty
 * constraint envelope — the adopter's own `CompositionRulesPort`. The write
 * boundary re-derives everything it can see and refuses independently.
 */
export function createAdminBundleSetCompositionHandler(deps: AdminBundleHandlerDeps) {
  return buildBundleHandler<SetBundleCompositionRequest>(
    deps,
    "setComposition",
    async (port, actorId, input) => {
      const composition = evaluateBundleComposition(input.components);
      if (!composition.ok) throw ruleRefusal(composition.violations);
      const constraint = await evaluateBundleCompositionConstraint(deps.compositionRules, {
        components: input.components,
        constraint: await port.loadCompositionConstraint(input.code),
      });
      if (!constraint.ok) throw ruleRefusal(constraint.violations);
      return port.setComposition(actorId, input);
    },
  );
}

export function createAdminBundleSetTargetPriceHandler(deps: AdminBundleHandlerDeps) {
  return buildBundleHandler<SetBundleTargetPriceRequest>(
    deps,
    "setTargetPrice",
    (port, actorId, input) => port.setTargetPrice(actorId, input),
  );
}

export function createAdminBundleArchiveHandler(deps: AdminBundleHandlerDeps) {
  return buildBundleHandler<ArchiveBundleRequest>(deps, "archive", (port, actorId, input) =>
    port.archive(actorId, input),
  );
}

export function createAdminBundleRestoreHandler(deps: AdminBundleHandlerDeps) {
  return buildBundleHandler<RestoreBundleRequest>(deps, "restore", (port, actorId, input) =>
    port.restore(actorId, input),
  );
}

export function createAdminBundleCloneDraftHandler(deps: AdminBundleHandlerDeps) {
  return buildBundleHandler<CloneBundleDraftRequest>(deps, "cloneDraft", (port, actorId, input) =>
    port.cloneDraft(actorId, input),
  );
}

/**
 * Activate (publish) — HUMAN-ONLY. The mutation's gate is `activation`, so the
 * factory wires it to the activation flag and refuses a machine actor (403) from
 * `allowedActorKinds` before the write is ever reached; the write routine RAISEs
 * 42501 independently as the second layer.
 */
export function createAdminBundleActivateHandler(deps: AdminBundleHandlerDeps) {
  return buildBundleHandler<ActivateBundleRequest>(deps, "activate", (port, actorId, input) =>
    port.activate(actorId, input),
  );
}

/** Deactivate (unpublish) — HUMAN-ONLY, gated identically to activate. */
export function createAdminBundleDeactivateHandler(deps: AdminBundleHandlerDeps) {
  return buildBundleHandler<DeactivateBundleRequest>(deps, "deactivate", (port, actorId, input) =>
    port.deactivate(actorId, input),
  );
}
