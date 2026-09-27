import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative, sep } from "node:path";

const repoRoot = process.cwd();

const PROVIDER_ENDPOINT_PATTERNS = {
  supabaseFunctionPath: /\/functions\/v1\b/g,
  supabaseStoragePath: /\/storage\/v1\/object\b/g,
  supabaseFunctionsHost: /\.supabase\.co\/functions\/v1\b/g,
  supabaseStorageHost: /\.supabase\.co\/storage\/v1\/object\b/g,
  supabaseFunctionsSubdomain: /\.functions\.supabase\.co\b/g,
  supabaseStorageSubdomain: /\.storage\.supabase\.co\b/g,
  viteSupabaseUrl: /import\.meta\.env\.VITE_SUPABASE_URL\b/g,
  viteSupabaseAnonKey: /import\.meta\.env\.VITE_SUPABASE_(?:ANON_KEY|PUBLISHABLE_KEY)\b/g,
  supabaseFunctionsUrlEnv: /\b(?:VITE_)?SUPABASE_FUNCTIONS_URL\b/g,
  supabaseStorageUrlEnv: /\b(?:VITE_)?SUPABASE_STORAGE_URL\b/g,
  unsubscribeFunctionsUrlEnv: /\bUNSUBSCRIBE_FUNCTIONS_BASE_URL\b/g,
} as const;

type PatternKey = keyof typeof PROVIDER_ENDPOINT_PATTERNS;
type PatternCounts = Record<PatternKey, number>;

const ALLOWED_PROVIDER_ENDPOINT_FILES = new Map<string, {
  patterns: readonly PatternKey[];
  reason: string;
}>([
  [
    "src/integrations/supabase/client.ts",
    {
      patterns: ["viteSupabaseUrl", "viteSupabaseAnonKey"],
      reason: "admin auth client composition root",
    },
  ],
  [
    "src/integrations/supabase/customerClient.ts",
    {
      patterns: ["viteSupabaseUrl", "viteSupabaseAnonKey"],
      reason: "customer auth client composition root",
    },
  ],
  [
    "api/_cron/abandonedCartHandlerWiring.ts",
    {
      patterns: ["unsubscribeFunctionsUrlEnv"],
      reason: "legacy marketing unsubscribe URL compatibility wiring",
    },
  ],
  [
    "api/_cron/backInStockHandlerWiring.ts",
    {
      patterns: ["unsubscribeFunctionsUrlEnv"],
      reason: "legacy marketing unsubscribe URL compatibility wiring",
    },
  ],
  [
    "api/_cron/reorderReminderHandlerWiring.ts",
    {
      patterns: ["unsubscribeFunctionsUrlEnv"],
      reason: "legacy marketing unsubscribe URL compatibility wiring",
    },
  ],
  [
    "api/_cron/outboxExtraHandlerManifest.ts",
    {
      patterns: ["unsubscribeFunctionsUrlEnv"],
      reason: "legacy marketing unsubscribe URL compatibility wiring",
    },
  ],
  [
    "api/_cron/outboxMarketingReadiness.ts",
    {
      patterns: ["unsubscribeFunctionsUrlEnv"],
      reason: "legacy marketing unsubscribe URL compatibility wiring",
    },
  ],
  [
    "api/_cron/reviewRequestOutboxHandlers.ts",
    {
      patterns: ["unsubscribeFunctionsUrlEnv"],
      reason: "legacy marketing unsubscribe URL compatibility wiring",
    },
  ],
  [
    "api/_cron/unsubscribeFunctionsBaseUrl.ts",
    {
      patterns: ["supabaseFunctionPath", "supabaseFunctionsHost", "supabaseFunctionsSubdomain"],
      reason: "legacy marketing unsubscribe provider endpoint adapter",
    },
  ],
]);

const RAW_PROVIDER_ENDPOINT_FIXTURES = {
  formerB2bEdgeCall: "fetch(`${import.meta.env.VITE_SUPABASE_URL}/functions/v1/send-b2b-inquiry`)",
  backendEdgeCall: "fetch(`${process.env.PROJECT_BASE_URL}/functions/v1/send-email`)",
  storageUrl: '"https://project.supabase.co/storage/v1/object/public/photos/file.jpg"',
  functionsUrlEnv: "const endpoint = process.env.SUPABASE_FUNCTIONS_URL;",
  storageUrlEnv: "const endpoint = process.env.SUPABASE_STORAGE_URL;",
} as const;

const RUNTIME_ENDPOINT_ROOTS = ["server/bff", "api/cron", "server/adapters/dhl"] as const;

function readFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return readFiles(full);
    return [full];
  });
}

function rel(file: string): string {
  return relative(repoRoot, file).split(sep).join("/");
}

function runtimeFiles(roots: readonly string[]): string[] {
  return roots
    .flatMap((root) => readFiles(join(repoRoot, root)))
    .map(rel)
    .filter((file) => /\.(ts|tsx|js|mjs|cjs)$/.test(file))
    .filter((file) => !/\.(test|spec)\./.test(file))
    .sort();
}

function countProviderEndpointReferences(source: string): PatternCounts {
  const stripped = stripComments(source);
  return Object.fromEntries(
    Object.entries(PROVIDER_ENDPOINT_PATTERNS).map(([key, pattern]) => [
      key,
      (stripped.match(pattern) ?? []).length,
    ]),
  ) as PatternCounts;
}

function total(counts: PatternCounts): number {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function runtimeProviderEndpointViolations(): Array<{
  file: string;
  key: PatternKey;
  count: number;
}> {
  return runtimeFiles(["src", ...RUNTIME_ENDPOINT_ROOTS]).flatMap((file) => {
    const counts = countProviderEndpointReferences(readFileSync(join(repoRoot, file), "utf8"));
    const allowed = ALLOWED_PROVIDER_ENDPOINT_FILES.get(file);
    return (Object.keys(PROVIDER_ENDPOINT_PATTERNS) as PatternKey[]).flatMap((key) => {
      const count = counts[key];
      if (count === 0 || allowed?.patterns.includes(key)) return [];
      return [{ file, key, count }];
    });
  });
}

describe("provider endpoint boundary", () => {
  it("recognizes raw Supabase provider endpoints in client runtime code", () => {
    expect(total(countProviderEndpointReferences(RAW_PROVIDER_ENDPOINT_FIXTURES.formerB2bEdgeCall))).toBeGreaterThan(0);
    expect(total(countProviderEndpointReferences(RAW_PROVIDER_ENDPOINT_FIXTURES.backendEdgeCall))).toBeGreaterThan(0);
    expect(total(countProviderEndpointReferences(RAW_PROVIDER_ENDPOINT_FIXTURES.storageUrl))).toBeGreaterThan(0);
    expect(total(countProviderEndpointReferences(RAW_PROVIDER_ENDPOINT_FIXTURES.functionsUrlEnv))).toBeGreaterThan(0);
    expect(total(countProviderEndpointReferences(RAW_PROVIDER_ENDPOINT_FIXTURES.storageUrlEnv))).toBeGreaterThan(0);
    expect(total(countProviderEndpointReferences(
      "requestBff('/api/bff/partners/b2b-inquiries', schema)",
    ))).toBe(0);
  });

  it("keeps browser, BFF, cron, and fulfillment adapter provider URLs behind review", () => {
    const staleExceptions = [...ALLOWED_PROVIDER_ENDPOINT_FILES.keys()].filter(
      (file) => !existsSync(join(repoRoot, file)),
    );
    expect(staleExceptions).toEqual([]);

    const missingReasons = [...ALLOWED_PROVIDER_ENDPOINT_FILES.entries()]
      .filter(([, exception]) => exception.reason.trim() === "")
      .map(([file]) => file);
    expect(missingReasons).toEqual([]);
    expect(runtimeProviderEndpointViolations()).toEqual([]);
  });
});

function stripComments(source: string): string {
  let output = "";
  let i = 0;
  let state: "normal" | "single" | "double" | "template" | "line" | "block" = "normal";

  while (i < source.length) {
    const char = source[i] ?? "";
    const next = source[i + 1] ?? "";

    if (state === "line") {
      if (char === "\n") {
        output += char;
        state = "normal";
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (char === "*" && next === "/") {
        i += 2;
        state = "normal";
      } else {
        i += 1;
      }
      continue;
    }
    if (state === "single" || state === "double" || state === "template") {
      output += char;
      if (char === "\\") {
        output += next;
        i += 2;
        continue;
      }
      if (
        (state === "single" && char === "'") ||
        (state === "double" && char === '"') ||
        (state === "template" && char === "`")
      ) {
        state = "normal";
      }
      i += 1;
      continue;
    }

    if (char === "/" && next === "/") {
      state = "line";
      i += 2;
      continue;
    }
    if (char === "/" && next === "*") {
      state = "block";
      i += 2;
      continue;
    }
    if (char === "'") state = "single";
    else if (char === '"') state = "double";
    else if (char === "`") state = "template";
    output += char;
    i += 1;
  }

  return output;
}
