import { createInvoiceContribution, createInvoiceServices } from "@openlup/platform/invoicing";
import type { Contribution, RequiredSchema } from "@openlup/core/readiness";
import { readInvoicingReferenceReadiness } from "./readiness.js";

/** Explicit host composition. Auth, run leases, transaction lanes and scheduling
 * stay with accountingRuntime and the existing outbox registry. Construction is inert.
 */
export function createM09InvoicingReferenceBinding<Result>(input: {
  enabled?: boolean;
  services: Parameters<typeof createInvoiceServices<Result>>[0];
  version: string;
  requiredSchema: RequiredSchema;
  handlers?: Contribution["handlers"];
  schedules?: Contribution["schedules"];
  routes?: Contribution["routes"];
}) {
  const services = createInvoiceServices({ ...input.services, enabled: input.enabled });
  const contribution = createInvoiceContribution({
    version: input.version, requiredSchema: input.requiredSchema,
    invoicing: { run: services.run },
    // Only explicitly selected hosts advertise existing registration descriptors.
    handlers: input.enabled === true ? input.handlers ?? [] : [],
    schedules: input.enabled === true ? input.schedules ?? [] : [],
    routes: input.enabled === true ? input.routes ?? [] : [],
  });
  return { services, ...contribution,
    readiness: () => readInvoicingReferenceReadiness({ enabled: input.enabled, readiness: services.readiness }),
  };
}
