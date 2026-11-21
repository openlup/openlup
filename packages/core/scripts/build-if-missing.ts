import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { env as processEnvironment, exit, platform } from "node:process";

if (processEnvironment.OPENLUP_DIST_READY === "1" && existsSync("dist")) {
  exit(0);
}

execFileSync(platform === "win32" ? "npm.cmd" : "npm", ["run", "build"], {
  stdio: "inherit",
});
