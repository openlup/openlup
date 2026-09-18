// The two facts an order poll needs from the connection registry: which connections are live, and
// where the last poll of each one got to.
//
// `pull_cursor` and `pull_watermark_at` were authored on `sales_channel_connections` by the
// registry wave and have been dormant since. Nothing new is stored here — this adapter is only the
// reader and writer B2 said would arrive with a puller.

export interface ChannelConnectionPullRow {
  connectionId: string;
  slug: string;
  connectorProviderKind: string;
  connectorShape: string;
  pullCursor: string | null;
  pullWatermarkAt: string | null;
}

export interface ChannelConnectionPullPort {
  listPullableConnections(): Promise<readonly ChannelConnectionPullRow[]>;
  recordPullProgress(input: {
    connectionId: string;
    pullCursor: string | null;
    pullWatermarkAt: string | null;
  }): Promise<void>;
}

interface QueryError {
  code?: string;
  message?: string;
}

export interface ManagedChannelConnectionQuery {
  select(columns: string): ManagedChannelConnectionQuery;
  in(column: string, values: readonly string[]): PromiseLike<{ data: unknown; error: QueryError | null }>;
  update(values: Record<string, unknown>): ManagedChannelConnectionUpdate;
}

export interface ManagedChannelConnectionUpdate {
  eq(column: string, value: unknown): PromiseLike<{ data: unknown; error: QueryError | null }>;
}

export interface ManagedChannelConnectionClient {
  from(table: string): ManagedChannelConnectionQuery;
}

const PULL_COLUMNS = "id, slug, connector_provider_kind, connector_shape, pull_cursor, pull_watermark_at";

/**
 * `testing` is read alongside `active` for the same reason admission accepts it: that status exists
 * so an operator can drive real deliveries through a surface before opening it. `disabled` and
 * `sunset` are not polled.
 */
const PULLABLE_STATUSES = ["active", "testing"] as const;

export function createManagedChannelConnectionPullStore(
  client: ManagedChannelConnectionClient,
): ChannelConnectionPullPort {
  return {
    async listPullableConnections() {
      const { data, error } = await client
        .from("sales_channel_connections")
        .select(PULL_COLUMNS)
        .in("status", [...PULLABLE_STATUSES]);
      if (error) throw failure("sales_channel_connections_read", error);
      if (!Array.isArray(data)) return [];
      return data.map(mapRow);
    },

    async recordPullProgress(input) {
      const { error } = await client
        .from("sales_channel_connections")
        .update({
          pull_cursor: input.pullCursor,
          pull_watermark_at: input.pullWatermarkAt,
          updated_at: new Date().toISOString(),
        })
        .eq("id", input.connectionId);
      if (error) throw failure("sales_channel_connections_pull_progress", error);
    },
  };
}

function mapRow(value: unknown): ChannelConnectionPullRow {
  if (!value || typeof value !== "object") {
    throw new Error("channel_connection_row_invalid");
  }
  const row = value as Record<string, unknown>;
  return {
    connectionId: requiredString(row.id, "connection.id"),
    slug: requiredString(row.slug, "connection.slug"),
    connectorProviderKind: requiredString(row.connector_provider_kind, "connection.connector_provider_kind"),
    connectorShape: requiredString(row.connector_shape, "connection.connector_shape"),
    pullCursor: nullableString(row.pull_cursor),
    pullWatermarkAt: nullableString(row.pull_watermark_at),
  };
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function requiredString(value: unknown, path: string): string {
  const parsed = nullableString(value);
  if (!parsed) throw new Error(`channel_connection_row_invalid: ${path}`);
  return parsed;
}

function failure(operation: string, error: QueryError): Error & { code?: string } {
  const raised = new Error(`${operation}_failed: ${error.message ?? error.code ?? "unknown"}`) as Error & {
    code?: string;
  };
  raised.code = error.code;
  return raised;
}
