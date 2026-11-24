// Historical identities are ordering tokens. Only newly allocated slots must be UTC seconds.
export const MIGRATION_RAILS = ['db/platform/migrations/', 'supabase/migrations/'];
const MIGRATION_PATH = /^(db\/platform\/migrations\/|supabase\/migrations\/)(?:(q2|qa|qb)_)?([0-9]{14})_([A-Za-z0-9_-]+\.sql)$/u;
const BASELINE = '00000000000000';
const FIRST_SLOT = '19700101000000';
const MIN_SECOND = -62135596800;
const MAX_SECOND = 253402300799;

export function migrationIdentity(path) {
  const match = MIGRATION_PATH.exec(path);
  if (!match) return undefined;
  const [, root, qualifier, version, name] = match;
  return { rail: root === MIGRATION_RAILS[0] ? 'portable' : 'managed', root, qualifier, version, name };
}

function formatUtcSecond(second) {
  return new Date(second * 1000).toISOString().slice(0, 19).replace(/[-:T]/gu, '');
}

export function isUtcMigrationSlot(slot) {
  if (!/^[0-9]{14}$/u.test(slot) || slot.startsWith('0000')) return false;
  const iso = `${slot.slice(0, 4)}-${slot.slice(4, 6)}-${slot.slice(6, 8)}T${slot.slice(8, 10)}:${slot.slice(10, 12)}:${slot.slice(12)}Z`;
  const time = Date.parse(iso);
  return Number.isFinite(time) && formatUtcSecond(time / 1000) === slot;
}

export function nextFreeMigrationSlot(bound) {
  if (!/^[0-9]{14}$/u.test(bound)) throw new Error(`migration slots: invalid 14-digit bound ${bound}`);
  if (bound === BASELINE) return FIRST_SLOT;
  let low = MIN_SECOND;
  let high = MAX_SECOND;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (formatUtcSecond(middle) > bound) high = middle;
    else low = middle + 1;
  }
  const candidate = formatUtcSecond(low);
  if (candidate <= bound) throw new Error(`migration slots: UTC range exhausted above ${bound}`);
  return candidate;
}

export function planMigrationSlots(paths, mainPaths, { bounds = [], unavailable = () => false } = {}) {
  const mainSlots = mainPaths.flatMap(path => migrationIdentity(path)?.version ?? []);
  const floor = [BASELINE, ...mainSlots, ...bounds].sort().at(-1);
  const used = new Set(mainSlots);
  const occupiedPaths = new Set(mainPaths.map(path => path.toLowerCase()));
  const additions = paths.flatMap(path => {
    const identity = migrationIdentity(path);
    return identity && !identity.qualifier && identity.version !== BASELINE ? [{ path, ...identity }] : [];
  }).sort((a, b) => a.version < b.version ? -1 : Number(a.version > b.version));
  const oldVersions = new Set();
  for (const { path, version } of additions) {
    if (oldVersions.has(version)) throw new Error(`migration slots: ambiguous draft version ${version} at ${path}`);
    oldVersions.add(version);
    used.add(version);
  }
  const freeAbove = (bound, pathForSlot = () => undefined) => {
    let slot = nextFreeMigrationSlot(bound);
    while (used.has(slot) || unavailable(pathForSlot(slot))) slot = nextFreeMigrationSlot(slot);
    return slot;
  };
  let bound = floor;
  const moves = additions.map(({ path, version, root, name }) => {
    const pathForSlot = slot => `${root}${slot}_${name}`;
    const keep = isUtcMigrationSlot(version) && version > bound && !occupiedPaths.has(path.toLowerCase()) && !unavailable(path, path);
    const targetVersion = keep ? version : freeAbove(bound, pathForSlot);
    bound = targetVersion;
    used.add(targetVersion);
    return { sourcePath: path, sourceVersion: version, targetPath: pathForSlot(targetVersion), targetVersion };
  });
  return { floor, moves, next: () => freeAbove(bound) };
}
