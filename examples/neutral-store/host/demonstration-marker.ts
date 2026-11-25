export const demonstrationMarker = 'openlup-neutral-store-demo-v1';
export const isDemonstrationMarker = (value: unknown) => value === demonstrationMarker;
export const demonstrationMarkerQuery = `SELECT pg_catalog.shobj_description(oid, 'pg_database') AS marker
  FROM pg_catalog.pg_database WHERE datname = pg_catalog.current_database()`;
