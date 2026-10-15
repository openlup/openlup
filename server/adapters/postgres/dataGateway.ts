// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform.
//
// Capability names are the access rule. Each named lane below is the package's role-free lane,
// handed to exactly one owner-authority adapter of this application.
import {
  createPostgresRoleFreeTransactionLane,
  type PostgresRoleFreeTransactionLane,
} from "@openlup/platform/data";

export {
  createPostgresDataGateway,
  createPostgresGatewayTypeOverrides,
  postgresTimestampTzToRfc3339,
  resolvePostgresDataGatewayEnv,
  type PostgresDataGatewayEnv,
  type PostgresDataGatewayOptions,
} from "@openlup/platform/data";

/** Role-free transaction lane for only the authored Postgres outbox adapter. */
export type PostgresOutboxTransactionLane = PostgresRoleFreeTransactionLane;
/** Role-free transaction lane for only the public platform job-control adapter. */
export type PostgresPlatformJobTransactionLane = PostgresRoleFreeTransactionLane;
/** Role-free transaction lane for only the direct transactional-delivery receipt adapter. */
export type PostgresTransactionalDeliveryTransactionLane = PostgresRoleFreeTransactionLane;
/** Role-free transaction lane for only the paid-order accounting document adapter. */
export type PostgresAccountingTransactionLane = PostgresRoleFreeTransactionLane;
/** Role-free transaction lane for only the direct channel-ingest ledger adapter. */
export type PostgresChannelIngestTransactionLane = PostgresRoleFreeTransactionLane;
/** Role-free transaction lane for only the public fulfillment shipment-spine adapter. */
export type PostgresFulfillmentTransactionLane = PostgresRoleFreeTransactionLane;
/** Role-free transaction lane for only the communications control-plane adapter. */
export type PostgresCommunicationsControlPlaneTransactionLane = PostgresRoleFreeTransactionLane;
export type PostgresPlatformControlPlaneTransactionLane = PostgresRoleFreeTransactionLane;
/** Role-free transaction lane for only the direct bundle admin-write adapter. */
export type PostgresBundleAdminWriteTransactionLane = PostgresRoleFreeTransactionLane;
export type PostgresCustomerRecoveryTransactionLane = PostgresRoleFreeTransactionLane;
export type PostgresAutomaticRenewalTransactionLane = PostgresRoleFreeTransactionLane;
export type PostgresAdminInventoryTransactionLane = PostgresRoleFreeTransactionLane;
export type PostgresDunningLifecycleTransactionLane = PostgresRoleFreeTransactionLane;
export type PostgresPromotionClaimTransactionLane = PostgresRoleFreeTransactionLane;
export type PostgresCheckoutRecoveryOperationsTransactionLane = PostgresRoleFreeTransactionLane;

export const createPostgresOutboxTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresPlatformJobTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresTransactionalDeliveryTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresAccountingTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresChannelIngestTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresFulfillmentTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresCommunicationsControlPlaneTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresPlatformControlPlaneTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresBundleAdminWriteTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresCustomerRecoveryTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresAutomaticRenewalTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresAdminInventoryTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresDunningLifecycleTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresPromotionClaimTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresCheckoutRecoveryOperationsTransactionLane = createPostgresRoleFreeTransactionLane;
export const createPostgresCustomerDiagnosticHistoryTransactionLane = createPostgresRoleFreeTransactionLane;
