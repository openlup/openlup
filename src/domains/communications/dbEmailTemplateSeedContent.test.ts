import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// Guards the LIVE seed migrations (not just the policy-file snapshots) against the
// food-transition copy contradiction that shipped in the `delivered` tester email:
// the HTML body said "3–5 dni" (en-dash) while the text + in-transit said "7-10 dni",
// because a corrective migration used a plain-hyphen `replace()` that missed the
// en-dash. The policy-snapshot test never sees migration body_html, so the drift was
// invisible to CI. This scans the migration that is the CURRENT source of truth for
// these slugs and asserts the food-transition window is the canonical 7-10 days.
//
// Self-following: it picks the LATEST-timestamped migration that writes the
// delivered/in-transit templates, so it keeps guarding the effective copy as the
// canonical seed moves to new migrations — no filename pin to maintain.

const migrationsDir = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

// "3-5 dni" / "3–5 dni" (hyphen OR en-dash) — the wrong, below-standard window.
const WRONG_TRANSITION_WINDOW = /3[-–]5\s*dni/i;
// A food-transition window mention in general: "<n>-<m> dni" near the seeding of
// these tester templates.
const ANY_TRANSITION_WINDOW = /\d+[-–]\d+\s*dni/i;

function latestSeedMigrationForTesterTransition(): { file: string; content: string } | null {
  const files = readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort(); // timestamp-prefixed → lexical sort is chronological
  let match: { file: string; content: string } | null = null;
  for (const file of files) {
    const content = readFileSync(join(migrationsDir, file), "utf8");
    const touchesTesterTemplates = content.includes("'delivered'") || content.includes("'in-transit'");
    if (touchesTesterTemplates && ANY_TRANSITION_WINDOW.test(content)) {
      match = { file, content }; // keep overwriting → the last (latest) wins
    }
  }
  return match;
}

describe("tester template seed content", () => {
  it("the canonical delivered/in-transit seed uses the 7-10 day food-transition window", () => {
    const latest = latestSeedMigrationForTesterTransition();
    expect(latest, "no migration seeds the delivered/in-transit tester templates").not.toBeNull();
    expect(
      WRONG_TRANSITION_WINDOW.test(latest!.content),
      `${latest!.file} reintroduces the wrong "3-5 dni" food-transition window (en-dash or hyphen)`,
    ).toBe(false);
    expect(
      /7-10\s*dni/i.test(latest!.content),
      `${latest!.file} should state the canonical "7-10 dni" transition window`,
    ).toBe(true);
  });
});
