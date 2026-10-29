import { createRiskBindings } from "@openlup/platform/risk/server";
import { createRiskContribution } from "@openlup/platform/composition";
import type { ReadinessReport, RequiredSchema } from "@openlup/core/readiness";
import type { HttpRequest, HttpResponse } from "@openlup/platform/http";
import { bffResponder } from "../../_lib/bff/response.js";

/** Inert recipe. Hosts own rail construction, trusted actor mapping and mounting. */
export function createM15RiskReferenceBinding(input: Omit<Parameters<typeof createRiskBindings>[0], "respond"> & {
  enabled?: boolean;
  /** Only these callables are advertised; none is mounted by this factory. */
  selectedRoutes?: readonly ("list" | "detail" | "decision")[];
  version: string;
  requiredSchema: RequiredSchema;
  readiness(schema: RequiredSchema): Promise<ReadinessReport>;
}) {
  const enabled = input.enabled === true;
  const bound = createRiskBindings({ ...input, respond: bffResponder });
  async function readiness() {
    if (!enabled) return { kind: "refused", code: "disabled" } as const;
    const report = await input.readiness(input.requiredSchema);
    return report.state === "ready" ? { kind: "ready" } as const
      : { kind: "refused", code: `schema_${report.state}` } as const;
  }
  const assessmentPort: typeof input.assessmentPort = {
    async assessPaidOrder(request) {
      const state = await readiness();
      return state.kind === "ready" ? bound.outboxRisk.riskPort.assessPaidOrder(request)
        : { kind: "retryable", reason: `risk_${state.code}` };
    },
  };
  function guardedRoute(name: "list" | "detail" | "decision") {
    return async (req: HttpRequest, res: HttpResponse): Promise<void> => {
      const state = await readiness();
      if (state.kind === "refused") {
        bffResponder.sendBffError(res, "UPSTREAM_UNAVAILABLE", `Risk binding unavailable: ${state.code}`);
        return;
      }
      return bound[name](req, res);
    };
  }
  const services = { list: guardedRoute("list"), detail: guardedRoute("detail"), decision: guardedRoute("decision") };
  const routeIds = {
    list: "/api/bff/admin/risk/cases",
    detail: "/api/bff/admin/risk/cases/detail",
    decision: "/api/bff/admin/risk/cases/decision",
  };
  const selected = [...new Set(input.selectedRoutes ?? [])];
  const contribution = createRiskContribution({
    version: input.version, requiredSchema: input.requiredSchema,
    assessPaidOrder: enabled ? assessmentPort.assessPaidOrder : null,
    routes: enabled ? selected.map(name => ({ id: routeIds[name], handle: services[name] })) : [],
  });
  return {
    services, readiness,
    outboxRisk: { riskPort: assessmentPort, riskEnabled: enabled },
    ...contribution,
  };
}
