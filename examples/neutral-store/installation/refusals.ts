import { installationFinding, isInstallationRefusal, refusal, up } from '../shared/refusals.ts';
export { buildGuidance, buildRefusal, installationFinding, isInstallationRefusal, packBuildFilename, refusal,
  rulesRecheck, up } from '../shared/refusals.ts';

const upJson = 'Run `./lifecycle up --json`';
const prerequisite = ' after correcting the failed prerequisite.';
export const infrastructure = {
  cause: 'The starter did not receive a verified result from the installation boundary.',
  fix: "Check image dependencies, rules-file access, database reachability, TLS and driver initialization, installer login and grants, and the complete qualified migration set. Use the starter's default transaction isolation. For a receipt integrity failure, verify the installed package and schema pair before replaying the same declaration.",
  recheck: upJson + prerequisite,
};

export function installationFailure(error: unknown, path = '', phase?: 'publish' | 'launch') {
  if (isInstallationRefusal(error)) return error;
  const guidance = phase === 'publish' ? ' Correct volume access and replay the same declaration to publish pending builds.'
    : phase === 'launch' ? ' Check Compose availability, the image build, application health and build-volume access.' : '';
  return refusal('starter_installation_failed', path, 'The demonstration installation did not complete.',
    infrastructure.cause, infrastructure.fix + guidance, phase ? infrastructure.recheck : up.slice(0, -1) + prerequisite, error);
}

export function installationReport(error: unknown): string | undefined {
  const finding = installationFinding(error);
  if (!finding) return;
  const { code, observed, cause: causeText, fix, recheck } = finding;
  const safe = observed.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, char => {
    const escaped = JSON.stringify(char).slice(1, -1);
    return escaped === char ? `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}` : escaped;
  });
  return `${code}\nObserved: ${safe}\nCause: ${causeText}\nFix: ${fix}\nRecheck: ${recheck}\n`;
}
