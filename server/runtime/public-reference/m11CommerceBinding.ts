import { createCommerceContribution } from "@openlup/platform/composition";
import type { Contribution, ReadinessReport, RequiredSchema } from "@openlup/core/readiness";
import { createPostgresCheckoutRecoveryOperations } from "../../adapters/postgres/checkoutRecoveryOperations.js";
import type { PgQueryExecutor } from "../../adapters/postgres/queryBuilder.js";
import { m11CommerceSchema } from "./m11CommerceSchema.js";

type Callable = (...args: never[]) => unknown;
type Refusal = { kind: "refused"; code: string };
type Guarded<Operations extends Record<string, Callable>> = {
  [Name in keyof Operations]: (...args: Parameters<Operations[Name]>) => Promise<Awaited<ReturnType<Operations[Name]>> | Refusal>;
};

/** Inert native recovery and existing package callables. The host owns admission,
 * authentication, leases and installation; disable its incumbent before replacement.
 */
export function createM11CommerceReferenceBinding<Commerce extends Record<string, Callable>>(input: {
  enabled?: boolean;
  executor: PgQueryExecutor;
  /** Already bound package/reference operations, with their original receivers. */
  commerce: Commerce;
  requiredObjects: RequiredSchema["objects"];
  version: string;
  catalogue: { version: string; migration: string };
  readiness(schema: RequiredSchema): Promise<ReadinessReport>;
  handlers?: Contribution["handlers"];
  schedules?: Contribution["schedules"];
  routes?: Contribution["routes"];
}) {
  const enabled = input.enabled === true;
  const schema = m11CommerceSchema(input.catalogue, input.requiredObjects);
  const native = createPostgresCheckoutRecoveryOperations(input.executor);
  const recovery = {
    abandonedReminders: native.abandonedReminderPort.enqueue,
    recoveryReminders: native.checkoutRecoveryReminderPort.enqueue,
    authorizeReminder: native.deliveryAuthorizationPort.authorize,
    pruneOutbox: native.outboxPrunePort.pruneOutbox,
  };
  for (const name of Object.keys(recovery)) {
    if (Object.prototype.hasOwnProperty.call(input.commerce, name)) throw new Error(`commerce_duplicate_operation:${name}`);
  }
  const operations = { ...input.commerce, ...recovery };
  const observe = input.readiness;
  async function readiness() {
    if (!enabled) return { kind: "refused", code: "disabled" } as const;
    const report = await observe(schema);
    return report.state === "ready" ? { kind: "ready" } as const : { kind: "refused", code: `schema_${report.state}` } as const;
  }
  const guarded = new Map<Callable, Callable>();
  const services = Object.fromEntries(Object.entries(operations).map(([name, execute]) => {
    if (typeof execute !== "function") throw new Error(`commerce_operation_required:${name}`);
    let run = guarded.get(execute);
    if (!run) {
      run = async (...args: never[]) => {
        const state = await readiness();
        return state.kind === "ready" ? execute(...args) : state;
      };
      guarded.set(execute, run);
    }
    return [name, run];
  })) as Guarded<typeof operations>;
  function selected(execute: Callable) {
    const run = guarded.get(execute);
    if (!run) throw new Error("commerce_entry_operation_required");
    return run;
  }
  const contribution = createCommerceContribution({ version: input.version, requiredSchema: schema,
    commerce: Object.fromEntries(Object.entries(services).map(([name, run]) => [name, enabled ? run : null])),
    handlers: enabled ? input.handlers ?? [] : [],
    schedules: enabled ? (input.schedules ?? []).map(schedule => ({ ...schedule, run: selected(schedule.run) })) : [],
    routes: enabled ? (input.routes ?? []).map(route => ({ ...route, handle: selected(route.handle) })) : [],
  });
  return { services, readiness, schema, ...contribution };
}
