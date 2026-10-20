import type { DeliveryReconciliationPort, NativeDeliveryStore, createPostgresDeliveryReconciliationPort } from "@openlup/platform/communications";
import type * as DeliveryAdapter from "@openlup/platform/communications/resend";
import type * as MarketingAdapter from "@openlup/platform/communications/klaviyo";
import type { admitReferenceCommunications, createReferenceCommunications } from "./referenceComposition.js";

type Admission = Awaited<ReturnType<typeof admitReferenceCommunications>>;
type Marketing = ReturnType<typeof MarketingAdapter.createKlaviyoMarketingAdapter>;
export interface A1HostInputs {
  admission: Omit<Parameters<typeof admitReferenceCommunications>[0], "runtime">;
  migrationIdentity: string;
  sender: Parameters<typeof DeliveryAdapter.createResendTransport>[0];
  callback: Parameters<typeof DeliveryAdapter.createResendWebhookHandler>[0];
  marketing: Parameters<typeof MarketingAdapter.createKlaviyoMarketingAdapter>[0];
  delivery: {
    database: Parameters<typeof createPostgresDeliveryReconciliationPort>[0];
    options: Parameters<typeof createPostgresDeliveryReconciliationPort>[1];
    resolveCredential(): string;
    now(): string;
    graceMinutes: number;
    limit: number;
    fetch?: typeof fetch;
  };
  select?: (ports: A1Ports) => Partial<Pick<Parameters<typeof createReferenceCommunications>[0], "routes" | "schedules" | "handlers">>;
}
export interface A1Ports {
  transport: ReturnType<typeof DeliveryAdapter.createResendTransport>;
  webhook: ReturnType<typeof DeliveryAdapter.createResendWebhookHandler>;
  reconcile: () => ReturnType<typeof DeliveryAdapter.runResendDeliveryReconciliation>;
  marketing: Marketing;
}

/** The only translation between the selected poll protocol and the native writer. */
function pollPort(store: NativeDeliveryStore): DeliveryReconciliationPort {
  const kinds: Readonly<Record<string, string>> = {
    "email.sent": "sent", "email.delivery_delayed": "delayed", "email.delivered": "delivered",
    "email.failed": "failed", "email.bounced": "bounced", "email.complained": "complained",
  };
  return {
    findFrozenSends: input => store.findFrozenSends(input),
    recordPollAttempt: input => store.recordPollAttempt(input),
    recordSendNotFound: input => store.recordSendNotFound(input),
    applyPolledEvent: input => {
      if (!Object.hasOwn(kinds, input.eventType)) throw new Error("a1_poll_kind_unknown");
      return store.applyPolledEvent({ ...input, eventType: kinds[input.eventType]! });
    },
  };
}

/** Explicit host opt-in. Importing this file installs no work and reads no environment. */
export async function createA1ReferenceBinding(input?: { enabled?: boolean; loadHostInputs(): A1HostInputs | Promise<A1HostInputs> }) {
  if (input?.enabled !== true) return undefined;
  const host = await input.loadHostInputs();
  const [deliveryAdapter, marketingAdapter, native, composition] = await Promise.all([
    import("@openlup/platform/communications/resend"),
    import("@openlup/platform/communications/klaviyo"),
    import("@openlup/platform/communications"),
    import("./referenceComposition.js"),
  ]);
  let admission: Admission | undefined = undefined;
  const guarded = new WeakSet<object>();
  const guard = <Args extends unknown[], Result>(effect: (...args: Args) => Result): typeof effect => {
    if (guarded.has(effect)) return effect;
    const callable = (...args: Args): Result => {
      if (!admission) throw new Error("communications_candidate_not_admitted");
      admission.assertCurrent();
      return effect(...args);
    };
    guarded.add(callable);
    return callable;
  };
  const sender = deliveryAdapter.createResendTransport(host.sender);
  sender.send = guard(sender.send);
  const callback = deliveryAdapter.createResendWebhookHandler(host.callback);
  const marketing = marketingAdapter.createKlaviyoMarketingAdapter(host.marketing);
  const ports: A1Ports = Object.freeze({
    transport: Object.freeze(sender),
    webhook: guard(callback),
    reconcile: guard(async () => {
      const store = native.createPostgresDeliveryReconciliationPort(host.delivery.database, host.delivery.options);
      try {
        return await deliveryAdapter.runResendDeliveryReconciliation({
          port: pollPort(store), apiKey: host.delivery.resolveCredential(), now: host.delivery.now(),
          graceMinutes: host.delivery.graceMinutes, limit: host.delivery.limit, fetch: host.delivery.fetch,
        });
      } finally { await store.close(); }
    }),
    marketing: Object.freeze({
      capabilities: marketing.capabilities, scope: marketing.scope,
      profiles: Object.freeze({ sync: guard(marketing.profiles.sync) }),
      consent: Object.freeze({ read: guard(marketing.consent.read) }),
      erasure: Object.freeze({ request: guard(marketing.erasure.request), read: guard(marketing.erasure.read) }),
      consentPush: Object.freeze({ capabilities: marketing.consentPush.capabilities, push: guard(marketing.consentPush.push) }),
      newsletter: Object.freeze({ ...marketing.newsletter, sync: guard(marketing.newsletter.sync), ...(marketing.newsletter.reconcile ? { reconcile: guard(marketing.newsletter.reconcile) } : {}) }),
      admit: guard(marketing.admit), apply: guard(marketing.apply), observe: guard(marketing.observe),
    }),
  });
  const selected = host.select?.(ports);
  const runtime = composition.createReferenceCommunications({
    bundle: "node-postgres", migrationIdentity: host.migrationIdentity, ports: { ...ports },
    routes: (selected?.routes ?? []).map(route => ({ ...route, handle: guard(route.handle) })),
    schedules: (selected?.schedules ?? []).map(schedule => ({ ...schedule, run: guard(schedule.run) })),
    handlers: selected?.handlers ?? [],
  });
  admission = await composition.admitReferenceCommunications({ ...host.admission, runtime });
  return Object.freeze({ ...admission, ports });
}
