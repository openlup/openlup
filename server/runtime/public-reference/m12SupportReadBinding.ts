import { createCustomer360ReadFacade } from "@openlup/platform/account-support";
import type { Customer360Lookup } from "@openlup/platform/account-support/contracts";
import {
  resolveCustomerSupportJourneyBinding,
  requireCustomerSupportActor,
  type CustomerSupportJourneyActor,
  type CustomerSupportJourneyBinding,
  type CustomerSupportJourneyBindingOptions
} from "../support/customerJourneyBinding.js";
import type { CustomerSupportJourneyReadPort } from "../../adapters/postgres/customerSupportJourney.js";
import type { ClientsPortableAdminReadPort } from "../../../src/domains/clients/portablePorts.js";
import type { CustomerDiagnosticHistoryBinding } from "../observability/customerDiagnosticHistoryBinding.js";
import type {
  CustomerDiagnosticHistoryInput,
  CustomerDiagnosticSearchInput,
  CustomerDiagnosticOverviewInput,
  CustomerDiagnosticHistoryPort,
  CustomerDiagnosticOverviewPort
} from "../../domains/observability/customerDiagnosticHistory.js";

export interface M12SupportReadSelection {
  enabled?: boolean;
  graph: "managed" | "native";
  /** Existing host authentication/administrator eligibility; no read before this resolves. */
  authorize(): Promise<CustomerSupportJourneyActor | null>;
  native?: { connectionString: string; options?: CustomerSupportJourneyBindingOptions };
  /** Selected host request scope retains the existing actor governance and cleanup contract. */
  managed?: Pick<CustomerSupportJourneyBinding, "run">;
  diagnostics?: Pick<CustomerDiagnosticHistoryBinding, "run">;
}

const unavailable = () => ({ supported: false, refusalCode: "host_binding_required" } as const);
type Reads = CustomerSupportJourneyReadPort & Pick<ClientsPortableAdminReadPort, "getPortableSummary">;

export function createM12SupportReadBinding(selection: M12SupportReadSelection) {
  function selected<Result>(read: () => Promise<Result>) {
    return selection.enabled ? read() : Promise.resolve(unavailable());
  }
  // Each invocation owns its actor; concurrent requests cannot share authority.
  function facade<DiagnosticRequest, DiagnosticResult>(
    readDiagnostics: (
      port: CustomerDiagnosticHistoryPort & CustomerDiagnosticOverviewPort,
      operatorId: string,
      request: DiagnosticRequest
    ) => Promise<DiagnosticResult> = async () => { throw new Error("diagnostic_scope_required"); }
  ) {
    let actor: CustomerSupportJourneyActor;
    let operatorId: string;
    async function run<Result>(work: (port: Reads) => Promise<Result>) {
      const resolved = selection.graph === "native" && selection.native
        ? resolveCustomerSupportJourneyBinding(
          { PLATFORM_BUNDLE: "node-postgres", DATABASE_URL: selection.native.connectionString },
          selection.native.options
        ).binding
        : selection.graph === "managed" ? selection.managed : undefined;
      if (!resolved) return unavailable();
      return resolved.run({ ...actor, intent: "read" }, work);
    }
    return createCustomer360ReadFacade({
      async authorize() {
        const authorized = await selection.authorize();
        if (!authorized) return false;
        operatorId = requireCustomerSupportActor(authorized);
        actor = authorized;
        return true;
      },
      journey: {
        searchCustomerJourney: (request: Customer360Lookup) => run(port => port.searchCustomerJourney(request)),
        getCustomerJourney: (request: Customer360Lookup) => run(port => port.getCustomerJourney(request))
      },
      summary: {
        getPortableSummary: (request: Parameters<Reads["getPortableSummary"]>[0]) => run(port => port.getPortableSummary(request))
      },
      diagnostics: {
        async history(request: DiagnosticRequest) {
          if (!selection.diagnostics) return unavailable();
          return selection.diagnostics.run(port => readDiagnostics(port, operatorId, request));
        }
      }
    });
  }
  return {
    searchCustomerJourney: (request: Customer360Lookup) => selected(() => facade().searchCustomerJourney(request)),
    getCustomerJourney: (request: Customer360Lookup) => selected(() => facade().getCustomerJourney(request)),
    getPortableSummary: (request: Parameters<Reads["getPortableSummary"]>[0]) => selected(() => facade().getPortableSummary(request)),
    searchDiagnostics: (request: Omit<CustomerDiagnosticSearchInput, "operatorId">) => selected(() => facade(
      (port, operatorId, input: typeof request) => port.search({ ...input, operatorId })
    ).history(request)),
    history: (request: Omit<CustomerDiagnosticHistoryInput, "operatorId">) => selected(() => facade(
      (port, operatorId, input: typeof request) => port.readSegment({ ...input, operatorId })
    ).history(request)),
    overview: (request: Omit<CustomerDiagnosticOverviewInput, "operatorId">) => selected(() => facade(
      (port, operatorId, input: typeof request) => port.overview({ ...input, operatorId })
    ).history(request)),
  };
}
