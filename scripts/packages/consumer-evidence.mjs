/** Project existing packageSmokeEvidence; never store a second export catalogue. */
export function consumerEvidence(manifest, gates) {
  const exports = Object.keys(manifest.exports ?? {}), surface = gates.packageSurface ?? {};
  if (JSON.stringify([...exports].sort()) !== JSON.stringify(Object.keys(surface).sort())) {
    throw new Error("CONSUMER_EVIDENCE:export_mismatch: align packageSurface with the selected manifest exports");
  }
  return exports.map(subpath => {
    const contract = surface[subpath];
    if (!Array.isArray(contract.packageSmokeEvidence) || contract.packageSmokeEvidence.length === 0
      || contract.packageSmokeEvidence.some(path => typeof path !== "string" || !path.trim())) {
      throw new Error("CONSUMER_EVIDENCE:smoke_evidence_required: retain existing witness paths for every export");
    }
    const specifier = manifest.name + (subpath === "." ? "" : subpath.slice(1));
    // The commands execute in the consumer directory, resolving that installed version.
    const importSource = `await import(${JSON.stringify(specifier)});`;
    return {
      specifier,
      maturity: contract.maturity,
      packageSmokeEvidence: [...contract.packageSmokeEvidence],
      sourceCheck: {
        workingDirectory: manifest.repository.directory,
        executable: "node",
        args: ["../../node_modules/vitest/vitest.mjs", "run", "--config", "vitest.config.ts", ...contract.packageSmokeEvidence],
        prerequisite: "Matching source revision, pinned toolchain, npm ci and built package prerequisites",
      },
      consumerCheck: { executable: "node", args: ["--input-type=module", "--eval", importSource] },
      proves: "Installed runtime entry resolves and evaluates in this consumer with its selected peers",
      doesNotProve: "Behavioural conformance, browser safety, declaration compatibility, application wiring or live provider readiness",
    };
  });
}
