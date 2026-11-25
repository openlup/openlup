import { readdirSync } from "node:fs";

export function findPlatformMigration(suffix: string): string {
  const directory = "db/platform/migrations";
  const matches = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(suffix));
  const [match] = matches;
  if (!match || matches.length !== 1) {
    throw new Error(`Expected exactly one migration ending in ${suffix} under ${directory}, found ${matches.length}`);
  }
  return `${directory}/${match.name}`;
}
