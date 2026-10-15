import { readFile } from "node:fs/promises";
import { relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { JOB_RUN_LEDGER_SQL_URL } from "../../src/job-ledger/sql.js";

describe("job-run ledger SQL asset", () => {
  it("points to an existing SQL file contained in the package SQL directory", async () => {
    const directory = fileURLToPath(new URL("../../sql/", import.meta.url));
    const path = fileURLToPath(JOB_RUN_LEDGER_SQL_URL);
    const within = relative(directory, path);
    expect(JOB_RUN_LEDGER_SQL_URL.protocol).toBe("file:");
    expect(within).not.toBe("");
    expect(within.split(sep)).not.toContain("..");
    expect(within.endsWith(".sql")).toBe(true);
    const bytes = await readFile(JOB_RUN_LEDGER_SQL_URL);
    const header = Buffer.from(
      "-- Public platform job-run ledger: the two relations a scheduled job needs to be\n"
      + "-- mutually exclusive across runners, and the two verbs its runtime actually calls.\n",
    );
    expect(bytes.subarray(0, header.length)).toEqual(header);
  });
});
