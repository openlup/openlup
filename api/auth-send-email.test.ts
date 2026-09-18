import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { config } from "./auth-send-email.js";

describe("auth-send-email API entrypoint", () => {
  it("keeps framework parsing off so the candidate verifies the original Standard Webhooks bytes", () => {
    expect(config).toEqual({ api: { bodyParser: false } });
  });

  it("composes content through the deployment seam rather than a private relative import", async () => {
    const source = await readFile(new URL("./auth-send-email.ts", import.meta.url), "utf8");

    expect(source).toContain('from "#auth-email-content"');
    expect(source).not.toContain("src/overlays/openlup/authEmailContent");
  });

  it("falls back to the public project URL the way every other server entrypoint here does", async () => {
    // Production carries VITE_SUPABASE_URL but not SUPABASE_URL. Reading only
    // the latter yielded an empty origin and shipped relative, unclickable
    // action links; every other api/ reader already pairs the two.
    const source = await readFile(new URL("./auth-send-email.ts", import.meta.url), "utf8");

    expect(source).toContain("env.SUPABASE_URL ?? env.VITE_SUPABASE_URL");
  });
});
