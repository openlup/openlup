import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export interface RecipeIndexEntry {
  readonly id: string;
  readonly domain: string;
  readonly providerKind: string;
  readonly displayName: string;
  readonly status: string;
  readonly regions?: readonly string[];
  readonly openlupPlatformRange: string;
  readonly testedAgainstPlatformVersion: string;
  readonly manifestPath: string;
}

export interface RecipeIndexDocument {
  readonly schemaVersion: 1;
  readonly platformVersion: string;
  readonly recipes: readonly RecipeIndexEntry[];
}

export interface RecipeValidationIssue {
  readonly manifestPath: string;
  readonly field: string;
  readonly message: string;
}

export interface SyncRecipeIndexOptions {
  readonly recipesRoot?: string;
  readonly platformVersion?: string;
  readonly check?: boolean;
}

export interface SyncRecipeIndexResult {
  readonly ok: boolean;
  readonly recipesRoot: string;
  readonly indexPath: string;
  readonly recipeCount: number;
  readonly changed: boolean;
  readonly issues: readonly RecipeValidationIssue[];
  readonly document?: RecipeIndexDocument;
}

interface JsonSchemaNode {
  readonly type?: string;
  readonly const?: unknown;
  readonly enum?: readonly unknown[];
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minItems?: number;
  readonly uniqueItems?: boolean;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly items?: JsonSchemaNode;
  readonly allOf?: readonly {
    readonly if?: JsonSchemaNode;
    readonly then?: JsonSchemaNode;
  }[];
}

const IGNORED_TOP_LEVEL_DIRS = new Set(["schema", "scripts", "node_modules"]);
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$/;

function asciiCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateSchemaNode(
  value: unknown,
  schema: JsonSchemaNode,
  pointer: string,
  errors: string[],
): void {
  if (schema.const !== undefined && value !== schema.const) {
    errors.push(`${pointer}: expected const ${JSON.stringify(schema.const)}`);
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push(`${pointer}: expected one of ${JSON.stringify(schema.enum)}`);
    return;
  }

  if (schema.type === "object") {
    if (!isPlainObject(value)) {
      errors.push(`${pointer}: expected object`);
      return;
    }
    for (const key of schema.required ?? []) {
      if (!(key in value)) {
        errors.push(`${pointer}.${key}: missing required property`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errors.push(`${pointer}.${key}: unexpected property`);
        }
      }
    }
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (key in value) {
          validateSchemaNode(value[key], propSchema, `${pointer}.${key}`, errors);
        }
      }
    }
  } else if (schema.type === "array") {
    if (!Array.isArray(value)) {
      errors.push(`${pointer}: expected array`);
      return;
    }
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${pointer}: expected at least ${schema.minItems} items`);
    }
    if (schema.uniqueItems) {
      const seen = new Set<string>();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) {
          errors.push(`${pointer}: duplicate item ${key}`);
        }
        seen.add(key);
      }
    }
    if (schema.items) {
      for (let idx = 0; idx < value.length; idx += 1) {
        validateSchemaNode(value[idx], schema.items, `${pointer}[${idx}]`, errors);
      }
    }
  } else if (schema.type === "string") {
    if (typeof value !== "string") {
      errors.push(`${pointer}: expected string`);
      return;
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${pointer}: length ${value.length} < minLength ${schema.minLength}`);
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      errors.push(`${pointer}: length ${value.length} > maxLength ${schema.maxLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${pointer}: value ${JSON.stringify(value)} does not match /${schema.pattern}/`);
    }
  }

  if (schema.allOf) {
    for (const branch of schema.allOf) {
      if (!branch.if || !branch.then) continue;
      const condErrors: string[] = [];
      validateSchemaNode(value, branch.if, pointer, condErrors);
      if (condErrors.length === 0) {
        validateSchemaNode(value, branch.then, pointer, errors);
      }
    }
  }
}

export function collectRecipeDiskFiles(recipeDir: string): string[] {
  const results: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      asciiCompare(a.name, b.name),
    );
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        results.push(path.relative(recipeDir, full).split(path.sep).join("/"));
      }
    }
  };
  walk(recipeDir);
  return results.sort(asciiCompare);
}

export function discoverRecipeDirectories(recipesRoot: string): string[] {
  const discovered: string[] = [];
  const topEntries = readdirSync(recipesRoot, { withFileTypes: true }).sort((a, b) =>
    asciiCompare(a.name, b.name),
  );
  for (const domainEntry of topEntries) {
    if (!domainEntry.isDirectory()) continue;
    if (domainEntry.name.startsWith(".") || IGNORED_TOP_LEVEL_DIRS.has(domainEntry.name)) continue;
    const domainDir = path.join(recipesRoot, domainEntry.name);
    const providerEntries = readdirSync(domainDir, { withFileTypes: true }).sort((a, b) =>
      asciiCompare(a.name, b.name),
    );
    for (const providerEntry of providerEntries) {
      if (!providerEntry.isDirectory() || providerEntry.name.startsWith(".")) continue;
      const recipeDir = path.join(domainDir, providerEntry.name);
      if (existsSync(path.join(recipeDir, "recipe.json"))) {
        discovered.push(recipeDir);
      }
    }
  }
  return discovered;
}

export function validateRecipeDirectory(
  recipesRoot: string,
  recipeDir: string,
  recipeSchema: JsonSchemaNode,
): { entry?: RecipeIndexEntry; issues: RecipeValidationIssue[] } {
  const relDir = path.relative(recipesRoot, recipeDir).split(path.sep).join("/");
  const manifestPath = `${relDir}/recipe.json`;
  const fullManifestPath = path.join(recipeDir, "recipe.json");
  const issues: RecipeValidationIssue[] = [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(fullManifestPath, "utf8"));
  } catch (error) {
    issues.push({
      manifestPath,
      field: "$",
      message: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return { issues };
  }

  const schemaErrors: string[] = [];
  validateSchemaNode(parsed, recipeSchema, "$", schemaErrors);
  for (const message of schemaErrors) {
    issues.push({ manifestPath, field: "schema", message });
  }
  if (!isPlainObject(parsed)) {
    return { issues };
  }

  const [expectedDomain] = relDir.split("/");
  if (parsed.id !== relDir) {
    issues.push({
      manifestPath,
      field: "id",
      message: `id ${JSON.stringify(parsed.id)} must match directory path ${JSON.stringify(relDir)}`,
    });
  }
  if (parsed.domain !== expectedDomain) {
    issues.push({
      manifestPath,
      field: "domain",
      message: `domain ${JSON.stringify(parsed.domain)} must match parent directory ${JSON.stringify(expectedDomain)}`,
    });
  }

  if (isPlainObject(parsed.files)) {
    const files = parsed.files;
    const allFiles = Array.isArray(files.allFiles)
      ? files.allFiles.filter((f): f is string => typeof f === "string")
      : [];
    const allFilesSet = new Set(allFiles);
    const diskFiles = collectRecipeDiskFiles(recipeDir);
    const sortedManifestFiles = [...allFiles].sort(asciiCompare);

    for (const file of diskFiles) {
      if (!allFilesSet.has(file)) {
        issues.push({
          manifestPath,
          field: "files.allFiles",
          message: `disk file ${JSON.stringify(file)} is missing from files.allFiles`,
        });
      }
    }
    for (const file of sortedManifestFiles) {
      const fullPath = path.join(recipeDir, file);
      if (!existsSync(fullPath) || !statSync(fullPath).isFile()) {
        issues.push({
          manifestPath,
          field: "files.allFiles",
          message: `declared file ${JSON.stringify(file)} does not exist on disk`,
        });
      }
    }

    for (const refKey of [
      "serverEntry",
      "clientContract",
      "conformanceTest",
      "mountProofTest",
      "liveQualificationDoc",
    ] as const) {
      const refVal = files[refKey];
      if (typeof refVal === "string" && !allFilesSet.has(refVal)) {
        issues.push({
          manifestPath,
          field: `files.${refKey}`,
          message: `referenced file ${JSON.stringify(refVal)} must be listed in files.allFiles`,
        });
      }
    }

    if (isPlainObject(parsed.browserSurface) && parsed.browserSurface.kind === "adapter-component") {
      for (const bKey of ["entry", "cspManifest"] as const) {
        const bVal = parsed.browserSurface[bKey];
        if (typeof bVal === "string" && !allFilesSet.has(bVal)) {
          issues.push({
            manifestPath,
            field: `browserSurface.${bKey}`,
            message: `browser surface file ${JSON.stringify(bVal)} must be listed in files.allFiles`,
          });
        }
      }
    }
  }

  if (issues.length > 0) {
    return { issues };
  }

  const regions = Array.isArray(parsed.regions)
    ? parsed.regions.filter((r): r is string => typeof r === "string")
    : undefined;

  const entry: RecipeIndexEntry = {
    id: String(parsed.id),
    domain: String(parsed.domain),
    providerKind: String(parsed.providerKind),
    displayName: String(parsed.displayName),
    status: String(parsed.status),
    ...(regions !== undefined ? { regions } : {}),
    openlupPlatformRange: String(parsed.openlupPlatformRange),
    testedAgainstPlatformVersion: String(parsed.testedAgainstPlatformVersion),
    manifestPath,
  };

  return { entry, issues };
}

function resolvePlatformVersion(recipesRoot: string, explicitVersion?: string): string {
  if (explicitVersion !== undefined) {
    if (!SEMVER_PATTERN.test(explicitVersion)) {
      throw new Error(`Invalid --platform-version ${JSON.stringify(explicitVersion)}: expected semver.`);
    }
    return explicitVersion;
  }

  const indexPath = path.join(recipesRoot, "index.json");
  if (existsSync(indexPath)) {
    try {
      const existing = JSON.parse(readFileSync(indexPath, "utf8")) as unknown;
      if (
        isPlainObject(existing) &&
        typeof existing.platformVersion === "string" &&
        SEMVER_PATTERN.test(existing.platformVersion)
      ) {
        return existing.platformVersion;
      }
    } catch {
      // Fall through to default when existing index.json is unreadable or corrupt.
    }
  }

  return "1.3.0";
}

export function buildRecipeIndex(
  recipesRoot: string,
  options?: { readonly platformVersion?: string },
): { document?: RecipeIndexDocument; issues: RecipeValidationIssue[] } {
  const schemaPath = path.join(recipesRoot, "schema", "recipe.schema.json");
  const recipeSchema = JSON.parse(readFileSync(schemaPath, "utf8")) as JsonSchemaNode;
  const recipeDirs = discoverRecipeDirectories(recipesRoot);
  const issues: RecipeValidationIssue[] = [];
  const entries: RecipeIndexEntry[] = [];
  const seenIds = new Set<string>();

  for (const recipeDir of recipeDirs) {
    const result = validateRecipeDirectory(recipesRoot, recipeDir, recipeSchema);
    issues.push(...result.issues);
    if (result.entry) {
      if (seenIds.has(result.entry.id)) {
        issues.push({
          manifestPath: result.entry.manifestPath,
          field: "id",
          message: `duplicate recipe id ${JSON.stringify(result.entry.id)}`,
        });
      } else {
        seenIds.add(result.entry.id);
        entries.push(result.entry);
      }
    }
  }

  if (issues.length > 0) {
    return { issues };
  }

  entries.sort((a, b) => asciiCompare(a.id, b.id));
  const platformVersion = resolvePlatformVersion(recipesRoot, options?.platformVersion);

  return {
    document: {
      schemaVersion: 1,
      platformVersion,
      recipes: entries,
    },
    issues: [],
  };
}

export function syncRecipeIndex(options: SyncRecipeIndexOptions = {}): SyncRecipeIndexResult {
  const defaultRecipesRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const recipesRoot = path.resolve(options.recipesRoot ?? defaultRecipesRoot);
  const indexPath = path.join(recipesRoot, "index.json");
  const checkOnly = options.check ?? false;

  const built = buildRecipeIndex(recipesRoot, {
    ...(options.platformVersion !== undefined ? { platformVersion: options.platformVersion } : {}),
  });

  if (built.issues.length > 0 || !built.document) {
    return {
      ok: false,
      recipesRoot,
      indexPath,
      recipeCount: 0,
      changed: false,
      issues: built.issues,
    };
  }

  const serialized = `${JSON.stringify(built.document, null, 2)}\n`;
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
  const changed = existing !== serialized;

  if (checkOnly) {
    if (changed) {
      return {
        ok: false,
        recipesRoot,
        indexPath,
        recipeCount: built.document.recipes.length,
        changed: true,
        issues: [
          {
            manifestPath: "index.json",
            field: "$",
            message:
              "recipes/index.json is out of date with recipes/*/*/recipe.json manifests. Run `node --experimental-strip-types recipes/scripts/generate-index.ts` and recheck with `--check`.",
          },
        ],
        document: built.document,
      };
    }
    return {
      ok: true,
      recipesRoot,
      indexPath,
      recipeCount: built.document.recipes.length,
      changed: false,
      issues: [],
      document: built.document,
    };
  }

  if (changed) {
    writeFileSync(indexPath, serialized, "utf8");
  }

  return {
    ok: true,
    recipesRoot,
    indexPath,
    recipeCount: built.document.recipes.length,
    changed,
    issues: [],
    document: built.document,
  };
}

function parseCliArgs(argv: readonly string[]): {
  check: boolean;
  json: boolean;
  platformVersion?: string;
  recipesRoot?: string;
} {
  let check = false;
  let json = false;
  let platformVersion: string | undefined;
  let recipesRoot: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--check") {
      check = true;
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "--platform-version" && i + 1 < argv.length) {
      platformVersion = argv[i + 1];
      i += 1;
    } else if (arg === "--recipes-root" && i + 1 < argv.length) {
      recipesRoot = argv[i + 1];
      i += 1;
    } else {
      throw new Error(`Unknown or incomplete argument: ${arg}`);
    }
  }

  return {
    check,
    json,
    ...(platformVersion !== undefined ? { platformVersion } : {}),
    ...(recipesRoot !== undefined ? { recipesRoot } : {}),
  };
}

function runCli(): void {
  let parsedArgs: ReturnType<typeof parseCliArgs>;
  try {
    parsedArgs = parseCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `Observed: ${error instanceof Error ? error.message : String(error)}\n` +
        `Cause: invalid CLI arguments.\n` +
        `Fix: pass optional --check, --json, --platform-version <semver>, or --recipes-root <dir>.\n` +
        `Recheck: node --experimental-strip-types recipes/scripts/generate-index.ts --check\n`,
    );
    process.exitCode = 64;
    return;
  }

  const result = syncRecipeIndex({
    check: parsedArgs.check,
    ...(parsedArgs.platformVersion !== undefined
      ? { platformVersion: parsedArgs.platformVersion }
      : {}),
    ...(parsedArgs.recipesRoot !== undefined ? { recipesRoot: parsedArgs.recipesRoot } : {}),
  });

  if (parsedArgs.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          formatVersion: 1,
          ok: result.ok,
          recipeCount: result.recipeCount,
          changed: result.changed,
          issues: result.issues,
        },
        null,
        2,
      )}\n`,
    );
  } else if (result.ok) {
    const verb = parsedArgs.check
      ? "verified"
      : result.changed
        ? "updated"
        : "already up to date";
    process.stdout.write(
      `recipes/index.json ${verb} (${result.recipeCount} recipes).\n`,
    );
  } else {
    process.stderr.write(`Observed: ${result.issues.length} recipe catalog issue(s).\n`);
    for (const issue of result.issues) {
      process.stderr.write(`  - ${issue.manifestPath} [${issue.field}]: ${issue.message}\n`);
    }
    process.stderr.write(
      `Cause: one or more recipe manifests failed validation or recipes/index.json drifted.\n` +
        `Fix: fix any manifest errors above and run \`node --experimental-strip-types recipes/scripts/generate-index.ts\`.\n` +
        `Recheck: node --experimental-strip-types recipes/scripts/generate-index.ts --check\n`,
    );
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntrypoint) {
  runCli();
}
