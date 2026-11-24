export const up = 'Run `./lifecycle up`.';
export const rulesRecheck = 'Run `node --test owned/catalogue-rules.test.cjs`, then `./lifecycle up`.';
const upJson = 'Run `./lifecycle up --json`';
const reports = new WeakSet<Error>();
export function refusal(code: string, path: string, observed: string, causeText: string, fix: string, recheck = up, cause?: unknown) {
  const error = Object.assign(code === 'starter_installation_failed' ? new Error(code, { cause }) : new Error(code),
    { code, path, observed, causeText, fix, recheck });
  reports.add(error);
  return error;
}

export function isInstallationRefusal(error: unknown): error is ReturnType<typeof refusal> {
  return error instanceof Error && reports.has(error);
}

export const buildGuidance = {
  starter_catalogue_build_missing: {
    cause: 'This host needs a verified rules build for the exact declared type version.',
    fix: 'For a declared type version, rebuild and run the demonstration installer with the matching declaration and rules. If the retained build conflicts, restore the original inputs or use the installed migration for an intentional new pack version. To author with an undeclared version, restore its matching declaration and rules, or select an installed type version in a new draft.',
    recheck: upJson + ', then repeat the draft action with the exact version.',
  },
  starter_catalogue_pack_invalid: {
    cause: 'The demonstration stores each pack version in a single file component.',
    fix: 'Use a pack ID that forms a supported filename. For an existing install, treat a changed pack ID as a new identity and reconcile its references.',
    recheck: 'Run `npm run catalogue:check:source`, then `./lifecycle up --json`.',
  },
  starter_catalogue_install_receipt_invalid: {
    cause: 'The receipt identity, manifest or type evidence disagrees with the installed declaration.',
    fix: 'Verify the qualified package and schema pair and correct the mismatch before replaying the unchanged declaration.',
    recheck: upJson + ' after restoring the qualified pair.',
  },
  starter_catalogue_build_conflict: {
    cause: 'A published pack build is immutable for its pack identity.',
    fix: 'Restore the original declaration and rules. For an intentional change, issue a new pack version and new versions of affected definitions when their installed identity changes. If storage is damaged, follow the installed guide for rebuilding a disposable demo.',
    recheck: upJson + ', then repeat the exact draft action.',
  },
};

export function buildRefusal(code: keyof typeof buildGuidance, path: string, observed: string) {
  const { cause, fix, recheck } = buildGuidance[code];
  return refusal(code, path, observed, cause, fix, recheck);
}

export function packBuildFilename(id: string, version: number) {
  const name = `${id}@${version}.json`;
  return /[/\\]/u.test(id) || id.includes('\0') || Buffer.byteLength(name) > 255 ? undefined : name;
}

export function installationFinding(error: unknown) {
  if (!isInstallationRefusal(error)) return;
  const { code, path, observed, causeText: cause, fix, recheck } = error;
  return { code, path, observed, cause, fix, recheck };
}
