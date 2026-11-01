/** Sparse native catalogue projections, never a standalone installation chain. */
export const CHANNEL_INGEST_MIGRATIONS = [
  { id: "20261030121000_channel_retained_basis", catalogPath: "db/platform/migrations/20261030121000_channel_retained_basis.sql", position: 89, sha256: "fcb9197f9a52eca3f7197669cb4ee615551654039a9394d22af80e53d61f33cf", url: new URL("../../../sql/20261030121000_channel_retained_basis.sql", import.meta.url) },
  { id: "20261030122000_channel_purchased_source", catalogPath: "db/platform/migrations/20261030122000_channel_purchased_source.sql", position: 90, sha256: "4dfe2fe885a047b3a56026ef85db43f89042a3e7e336d656cf4ed5931438ffe2", url: new URL("../../../sql/20261030122000_channel_purchased_source.sql", import.meta.url) },
] as const;
