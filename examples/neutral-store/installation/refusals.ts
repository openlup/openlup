export const up = 'Run `./lifecycle up`.';
const reports = new WeakSet<Error>();
export function refusal(code: string, path: string, observed: string, causeText: string, fix: string, recheck = up, cause?: unknown) {
  const error = Object.assign(code === 'starter_installation_failed' ? new Error(code, { cause }) : new Error(code),
    { code, path, observed, causeText, fix, recheck });
  reports.add(error);
  return error;
}

export function installationFailure(error: unknown, path = '') {
  if (isInstallationRefusal(error)) return error as ReturnType<typeof refusal>;
  return refusal('starter_installation_failed', path, 'The demonstration installation did not complete.',
    'The starter did not receive a verified result from the installation boundary.',
    "Check image dependencies, rules-file access, database reachability, TLS and driver initialization, installer login and grants, and the complete qualified migration set. Use the starter's default transaction isolation. For a receipt integrity failure, verify the installed package and schema pair before replaying the same declaration.",
    'Run `./lifecycle up` after correcting the failed prerequisite.', error);
}

export function isInstallationRefusal(error: unknown): boolean {
  return error instanceof Error && reports.has(error);
}

export function installationReport(error: unknown): string | undefined {
  if (!isInstallationRefusal(error)) return;
  const { code, observed, causeText, fix, recheck } = error as ReturnType<typeof refusal>;
  const safe = observed.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => {
    const escaped = JSON.stringify(char).slice(1, -1);
    return escaped === char ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : escaped;
  });
  return `${code}\nObserved: ${safe}\nCause: ${causeText}\nFix: ${fix}\nRecheck: ${recheck}\n`;
}
