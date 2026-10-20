import {
  createPostgresDeliveryReconciliationPort, createPostgresCommunicationSyncStore,
  createPostgresNotificationRecipientsPort, createPostgresConsentEvaluator,
  runDeliveryReconciliation, runCommunicationSyncDispatch,
  type NativeCommunicationsOptions, type NativeConsentOptions, type NativeSyncRegistration,
  type NativeConsentInput, type NativeNetworkTarget, type NewsletterSyncProviderPort,
  type NativeDeliveryStore, type DeliveryStatusRead, type DeliveryPollObservation, type CommunicationSyncConfig,
} from "@openlup/platform/communications";
import { createPostgresOutboxStore } from "@openlup/outbox/postgres";

export interface CommunicationsLifecycleBindingOptions extends NativeCommunicationsOptions {
  provider: NewsletterSyncProviderPort;
  /** Verified host principal; directory methods check live native authorization in their transaction. */
  operatorId: string;
  consent?: NativeConsentOptions;
}
/** Callable reference composition. No timer, cron, network reader or default membership provider. */
export function createCommunicationsLifecycleBinding(
  env: Record<string, string | undefined>, options: CommunicationsLifecycleBindingOptions,
) {
  if (env.PLATFORM_BUNDLE !== "node-postgres" || !env.DATABASE_URL?.trim()) throw new Error("native_communications_bundle_required");
  const database = { connectionString: env.DATABASE_URL };
  const using = async <T, Store extends { close(): Promise<void> }>(store: Store, work: (store: Store) => Promise<T>) => {
    try { return await work(store); } finally { await store.close(); }
  };
  const delivery = () => createPostgresDeliveryReconciliationPort(database, options);
  const sync = () => createPostgresCommunicationSyncStore(database, { ...options,providerKind: options.provider.providerKind,rail: db => createPostgresOutboxStore(db) });
  return {
    registerNetworkTarget: (input: NativeNetworkTarget) => using(delivery(), store => store.registerNetworkTarget(input)),
    findByMessageId: (id: string) => using(delivery(), store => store.findByMessageId(id)),
    listDeliveryEvidence: (limit: number) => using(delivery(), store => store.listEvidence({limit})),
    applyObservation: (input: Parameters<NativeDeliveryStore["applyObservation"]>[0]) => using(delivery(), store => store.applyObservation(input)),
    readDeliveryEvidence: (id: string) => using(delivery(), store => store.readEvidence(id)),
    reconcileDelivery: (input: { readEmail: (messageId: string) => Promise<DeliveryStatusRead>; observationFor: (read: DeliveryStatusRead) => DeliveryPollObservation | null; now: string; graceMinutes: number; limit: number }) =>
      using(delivery(), port => runDeliveryReconciliation({ ...input,port })),
    registerSyncWork: (input: NativeSyncRegistration) => using(sync(), store => store.registerWork(input)),
    dispatchSync: (config?: Partial<CommunicationSyncConfig>) => using(sync(), store => runCommunicationSyncDispatch({ store,provider: options.provider,config })),
    withRecipients: <T>(work: (port: ReturnType<typeof createPostgresNotificationRecipientsPort>) => Promise<T>) =>
      using(createPostgresNotificationRecipientsPort(database, options), work),
    evaluateConsent: (input: NativeConsentInput) => using(createPostgresConsentEvaluator(database, { ...options,...options.consent }), store => store.evaluate(input)),
  };
}
