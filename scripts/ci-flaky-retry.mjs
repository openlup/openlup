// Surfaces work that failed once and passed on its single hosted-CI retry.
import { appendFileSync } from "node:fs";
import { env as processEnvironment } from "node:process";

export const FLAKY_RETRY_PREFIX = "flaky-retry-passed:";

function escapeAnnotation(value) {
  return String(value).replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
}

export function isHostedCi(env = processEnvironment) {
  return env.CI === "true";
}

/** The lines printed for each retried-then-passed name: a plain marker and a warning annotation. */
export function formatFlakyRetryLines(names) {
  return names.flatMap((name) => [
    `${FLAKY_RETRY_PREFIX} ${name}`,
    `::warning title=Flaky test retried::${escapeAnnotation(name)}`,
  ]);
}

export function reportFlakyRetries(
  names,
  { env = processEnvironment, log = (line) => console.log(line), append = appendFileSync } = {},
) {
  if (names.length === 0) return;
  for (const line of formatFlakyRetryLines(names)) log(line);
  const summary = env.GITHUB_STEP_SUMMARY;
  if (summary) {
    append(summary, `${names.map((name) => `- ${FLAKY_RETRY_PREFIX} \`${name}\``).join("\n")}\n`);
  }
}
