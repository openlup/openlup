import { cpSync, mkdirSync, readdirSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { env as processEnvironment } from "node:process";

export function localFixtureEnvironment(): NodeJS.ProcessEnv {
  const env = { ...processEnvironment };
  for (const name of ["GITHUB_ACTIONS", "GITHUB_SHA", "GITHUB_EVENT_PATH", "GITHUB_EVENT_NAME", "GITHUB_REPOSITORY", "GITHUB_REF"]) {
    delete env[name];
  }
  return env;
}

export function fixtureNpmCli(): string {
  const cli = processEnvironment.npm_execpath;
  if (cli && isAbsolute(cli)) return cli;
  // Hosted shards run Vitest directly with the Node distribution from setup-node.
  return realpathSync(resolve(dirname(process.execPath), process.platform === "win32" ? "node_modules/npm/bin/npm-cli.js" : "npm"));
}

export function linkFixtureInstallation(source: string, fixture: string): void {
  const installed = join(source, "node_modules");
  const destination = join(fixture, "node_modules");
  mkdirSync(destination);
  // npm's relative workspace and executable links resolve inside the fixture.
  for (const entry of [".bin", ".package-lock.json", "@openlup"]) {
    cpSync(join(installed, entry), join(destination, entry), { recursive: true, verbatimSymlinks: true });
  }
  for (const entry of readdirSync(installed)) {
    if (entry.startsWith(".") || entry === "@openlup") continue;
    symlinkSync(join(installed, entry), join(destination, entry));
  }
}
