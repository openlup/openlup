/** Sparse projection only: install the complete canonical native prefix, never this unit alone. */
export const OPERATIONS_MIGRATIONS = {
  native: { units: [{ position: 28, catalogPath: "db/platform/migrations/20260814010000_platform_control_plane.sql",
    sha256: "b0c8ef6424ebc6f1a84cb132c37908f4831fa40484a729c3713cfb35936559c9",
    url: new URL("../../../sql/20260814010000_platform_control_plane.sql", import.meta.url) }] },
  managed: { verified: false },
} as const;
