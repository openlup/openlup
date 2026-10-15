// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform.
export {
  PgGatewayClient,
  PgQueryBuilder,
  type PgQueryExecutor,
  type PgShimError,
  type PgShimResult,
} from "@openlup/platform/data";
export type { PoolClient } from "pg";
