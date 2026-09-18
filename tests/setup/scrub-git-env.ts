// Verify W5: second line of defense behind scripts/run-vitest.mjs for direct
// `npx vitest` invocations — git-injected repo-location vars must never reach
// test-spawned `git` processes (a leaked `git init` once rewrote the real
// repo's shared config; see #1803). Lives under tests/ (not src/) because the
// client secret-boundary guard rightly forbids process.env reads in src.
for (const name of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
]) {
  delete process.env[name];
}
