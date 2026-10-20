import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import tseslint from "typescript-eslint";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const tsconfigRootDir = path.dirname(fileURLToPath(import.meta.url));

// Import boundaries. They use ESLint core rules only: `no-restricted-imports`
// for static imports and re-exports, `no-restricted-syntax` for literal loads.
// Both rules replace, not merge, their options when two config objects match a
// file, so each file set below gets one complete list:
//   1. outside packages/: a package is reached only through its declared exports;
//   2. domain code: additionally no provider SDK and no adapter, infra, runtime
//      or route-composition code (tests may compose a domain with an adapter);
//   3. packages/<name>/: package-local; outbox and platform may import exact public core exports;
//   4. portable package production source: additionally no provider SDK;
//   5. packages/platform/src/<module>/ production source: additionally the
//      module graph below.
const SOURCE_EXTENSIONS = "{ts,tsx,js,mjs,cjs}";
const MAX_PACKAGE_DEPTH = 12;
const PORTABLE_PACKAGE_DIRECTORIES = ["core", "ui", "outbox"];
// Packages that may import exact public `@openlup/core` exports.
const CORE_CONSUMING_PACKAGES = new Set(["@openlup/outbox", "@openlup/platform"]);
const DOMAIN_ROOTS = ["src/domains", "server/domains"];
const testFiles = (prefix) => [
  `${prefix}**/*.test.${SOURCE_EXTENSIONS}`,
  `${prefix}**/*.testFixtures.ts`,
];
const DOMAIN_TEST_FILES = DOMAIN_ROOTS.flatMap((root) => testFiles(`${root}/`));
// Directories that hold adapter, infra, composition-root or route code.
const INFRA_DIRECTORIES = ["api", "server/adapters", "server/bff", "server/infra", "server/runtime", "src/checkout/adapters", "src/integrations"];

const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rootPath = (file) => path.join(tsconfigRootDir, file);
const readJson = (file) => JSON.parse(readFileSync(rootPath(file), "utf8"));
// An `exports` key such as "./*" matches any subpath in its place.
const subpathRegex = (key) => escapeRegex(key.replace(/^\./, "")).replaceAll("\\*", ".+");

const workspacePackages = readdirSync(rootPath("packages"), { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && existsSync(rootPath(`packages/${entry.name}/package.json`)))
  .map(({ name: directory }) => {
    const manifest = readJson(`packages/${directory}/package.json`);
    if (typeof manifest.name !== "string") throw new Error(`packages/${directory}/package.json has no name`);
    const exports = manifest.exports && typeof manifest.exports === "object" ? Object.keys(manifest.exports) : ["."];
    return { directory, name: manifest.name, subpaths: exports.map(subpathRegex) };
  });

// A package.json `imports` target is a path string, a condition object or a
// fallback array, whose values are targets again, so they can nest. Every string
// leaf is a file the alias may resolve to, and an alias is infra when any one is.
const importTargetPaths = (target) => typeof target === "string" ? [target]
  : target !== null && typeof target === "object" ? Object.values(target).flatMap(importTargetPaths)
  : [];

const rootImportMap = readJson("package.json").imports ?? {};
const infraImportAliases = Object.entries(rootImportMap)
  .filter(([, target]) => importTargetPaths(target).some((leaf) =>
    INFRA_DIRECTORIES.some((directory) => path.posix.normalize(leaf).startsWith(`${directory}/`))))
  .map(([alias]) => alias);

const packageExports = {
  message: "Import a workspace package only through a subpath its package.json `exports` declares.",
  regexes: [
    `^\\.{1,2}/(?:.*/)?packages/(?:${workspacePackages.map(({ directory }) => escapeRegex(directory)).join("|")})(?:/|$)`,
    ...workspacePackages.map(({ name, subpaths }) =>
      `^${escapeRegex(name)}(?!(?:${subpaths.join("|")})$)(?:/.*)?$`),
  ],
};

const providerIsolation = {
  message: "Portable package source must not import provider SDKs; inject a port instead.",
  regexes: [
    "^(?:stripe|pg|openai)(?:/|$)",
    "^@(?:stripe|supabase|vercel|modelcontextprotocol)/",
  ],
};

const domainIsolation = {
  message: "Domain code must not import provider SDKs or adapter, infra, runtime or route code; inject a port instead.",
  regexes: [
    ...providerIsolation.regexes,
    // Reached only by climbing out of the domain tree, so shared helpers such as
    // server/_lib/bff or src/lib/bff stay importable.
    `^(?:\\./)?(?:\\.\\./)+(?:server/)?(?:adapters|infra|runtime|bff|api)(?:/|$)`,
    `^(?:\\./)?(?:\\.\\./)+(?:src/)?(?:integrations|checkout/adapters)(?:/|$)`,
    "^@/(?:integrations|checkout/adapters)(?:/|$)",
    ...(infraImportAliases.length > 0 ? [`^(?:${infraImportAliases.map(escapeRegex).join("|")})$`] : []),
  ],
};

// `depth` is the number of directories between the package root and the file;
// a file deeper than MAX_PACKAGE_DEPTH may not climb out of its directory at all.
const packageIsolation = (pkg, depth) => ({
  message: CORE_CONSUMING_PACKAGES.has(pkg.name)
    ? `A file under packages/${pkg.directory} stays package-local, except exact public core exports.`
    : `A file under packages/${pkg.directory} imports nothing outside that directory.`,
  regexes: [
    depth === null ? "^(?:\\./)?\\.\\.(?:/|$)" : `^(?:\\./)?(?:\\.\\./){${depth}}\\.\\.(?:/|$)`,
    "^/",
    "^@/",
    "^#",
    `^@openlup/(?!(?:${escapeRegex(pkg.name.replace(/^@openlup\//, ""))}${CORE_CONSUMING_PACKAGES.has(pkg.name) ? "|core" : ""})(?:/|$))`,
  ],
});

// `valueOnly` boundaries refuse only loads that bring in a value: their static
// imports go to the type-aware rule in platformModuleRules, and `import("…")`
// in a type position stays allowed.
function boundaryRules(boundaries, valueOnly = []) {
  const toEntries = (list, typePosition) => list.flatMap(({ message, regexes }) =>
    regexes.map((regex) => ({ regex, message, typePosition })));
  const entries = toEntries(boundaries, true);
  return {
    "no-restricted-imports": ["error", {
      patterns: entries.map(({ regex, message }) => ({ regex, message, caseSensitive: true })),
    }],
    // Literal `import()`, `require()` and `module.require()` loads, plain
    // templates, and `import("…")` in a type position. No alias/dataflow analysis.
    // esquery's regex literal cannot contain "/", so it is \x2F.
    "no-restricted-syntax": ["error", ...[...entries, ...toEntries(valueOnly, false)].flatMap(({ regex, message, typePosition }) => {
      const value = `/${regex.replaceAll("/", "\\x2F")}/`;
      return [
        `ImportExpression > Literal.source[value=${value}]`,
        `ImportExpression > TemplateLiteral.source[expressions.length=0] > TemplateElement[value.cooked=${value}]`,
        ...(typePosition ? [`TSImportType Literal[value=${value}]`] : []),
        `CallExpression[callee.type='Identifier'][callee.name='require'] > Literal.arguments[value=${value}]`,
        `CallExpression[callee.type='Identifier'][callee.name='require'] > TemplateLiteral.arguments[expressions.length=0] > TemplateElement[value.cooked=${value}]`,
        `CallExpression[callee.type='MemberExpression'][callee.object.name='module'][callee.property.name='require'][callee.computed=false] > Literal.arguments[value=${value}]`,
        `CallExpression[callee.type='MemberExpression'][callee.object.name='module'][callee.property.name='require'][callee.computed=false] > TemplateLiteral.arguments[expressions.length=0] > TemplateElement[value.cooked=${value}]`,
      ].map((selector) => ({ selector, message }));
    })],
  };
}

const sourceFiles = (prefix = "") => [`${prefix}**/*.${SOURCE_EXTENSIONS}`];

// The logical module graph of packages/platform/src, inventoried from the
// characterized source (docs/platform/ARCHITECTURE_AND_EXTENSIONS.md, "Internal
// boundaries and adapter isolation"). A module's production files import its own
// files freely, and another module only through that module's entry
// `<module>/index.js` along a declared edge: `values` admits any import, `types`
// type-only imports. Every directory of packages/platform/src is a module here.
// Optional `contracts: true` declares exactly one browser-safe sub-entry at
// <module>/contracts/index.ts; it has no module edges, including to its server entry.
export const PLATFORM_MODULE_GRAPH = {
  shipping: { contracts: true, values: [], types: ["bff", "http"] },
  promotions: { contracts: true, values: ["pricing"], types: ["data", "http", "bff"] },
  pricing: { contracts: true, values: [], types: ["bff", "http"] },
  // Bundle application factories bind host schemas/admin kit; only handler/responder types cross modules.
  // Native stores and the data type edge remain outside this application slice.
  catalog: { contracts: true, values: [], types: ["bff", "http"] },
  communications: { contracts: true, values: ["data", "identity"], types: ["http"] },
  identity: { contracts: true, values: ["bff", "data", "kernel"], types: ["http"] },
  kernel: { values: [], types: [] },
  http: { values: [], types: ["bff"] },
  bff: { values: ["kernel"], types: ["http"] },
  scheduler: { values: [], types: ["http"] },
  data: { values: ["kernel"], types: [] },
  blob: { values: [], types: [] },
  "job-ledger": { values: [], types: ["data"] },
  migrations: { values: [], types: [] },
  // The generic composer over the other modules' public ports and factories.
  composition: { values: ["blob", "bff", "data", "http", "job-ledger", "kernel", "migrations", "scheduler"], types: [] },
  inventory: { contracts: true, values: [], types: [] },
};
const PLATFORM_SOURCE = "packages/platform/src";

// Specifiers that would reach a module around its entry, at any depth: a relative path not in
// canonical form (an optional leading `./`, then `../` climbs, then named segments that are not
// empty, do not start with a dot and hold no backslash or percent sign); a package specifier with
// a `.`, `..` or empty segment (a dependency without an exports map resolves such a climb back
// into this tree); a backslash or percent sign anywhere; any control character or space (URL
// parsing strips them, so they can hide a climb or a URL); the package's own name; any other
// spelling of the `@openlup` scope (a case-insensitive file system resolves it to the workspace
// links); a test or fixture file, which these rules do not cover and so could relay an import; or
// a URL.
const platformModuleEscapes = (message) => ({ message, regexes: [
  "^@(?!openlup/)[Oo][Pp][Ee][Nn][Ll][Uu][Pp](?:/|$)",
  "(?:^|/)[^/]*\\.test(?:Fixtures)?(?:\\.[^/]*)?$",
  "[\\x00-\\x20\\x7f\\\\%]",
  "^(?!\\.)(?:.*/)?\\.{1,2}(?:/|$)",
  "^(?!\\.).*(?://|/$)",
  "^(?=\\.)(?!(?:\\./)?(?:\\.\\./)*(?:[^./\\\\%][^/\\\\%]*/)*[^./\\\\%][^/\\\\%]*$)",
  "^@openlup/platform(?:/|$)",
  "^(?!node:)[A-Za-z][A-Za-z0-9+.-]*:",
] });

// `depth` is the number of directories between the module root and the file.
function platformModuleBoundaries(module, depth, graph) {
  const { values, types } = graph[module];
  const entry = (name) => `${escapeRegex(name)}/index\\.js`;
  const toSource = `^(?:\\./)?(?:\\.\\./){${depth}}\\.\\./`;
  const message = `packages/platform module "${module}" imports its own files and other modules only through their entry <module>/index.js: `
    + `${values.length > 0 ? values.join(", ") : "none"}${types.length > 0 ? `; types only from ${types.join(", ")}` : ""}.`;
  return {
    graph: { message, regexes: [
      `${toSource}(?!${escapeRegex(module)}/|(?:${[...values, ...types].map(entry).join("|") || "(?!)"})$)`,
      ...platformModuleEscapes(message).regexes,
    ] },
    typeOnly: { message, regexes: types.length > 0 ? [`${toSource}(?:${types.map(entry).join("|")})$`] : [] },
  };
}

// Export the same rule factory used below so synthetic graphs exercise the real wiring.
export function platformModuleRules(pkg, module, graph = PLATFORM_MODULE_GRAPH) {
  const { contracts } = graph[module];
  if (contracts !== undefined && contracts !== true) throw new Error(`${module}: contracts must be true or omitted`);
  const ignores = testFiles(`${PLATFORM_SOURCE}/`);
  const message = `packages/platform module "${module}" imports other modules only through their entry <module>/index.js.`;
  const contractsRules = (depth) => {
    const segment = "[A-Za-z0-9_-][A-Za-z0-9_.-]*";
    const relative = `(?:\\./(?:\\.\\./){0,${depth}}${depth > 0 ? `|(?:\\.\\./){1,${depth}}` : ""})${segment}(?:/${segment})*\\.js`;
    const core = workspacePackages.find(({ name }) => name === "@openlup/core");
    const allowed = [relative, ...core.subpaths.map((subpath) => `@openlup/core${subpath}`)];
    const message = contracts === true
      ? `packages/platform module "${module}" contracts import only their own contracts files and exact public core exports.`
      : `packages/platform module "${module}" has no declared contracts entry.`;
    const rules = boundaryRules([{ message, regexes: [contracts === true ? `^(?!(?:${allowed.join("|")})$)` : "^"] }, platformModuleEscapes(message)]);
    // Reserve the loader-handle names in all identifier positions, including
    // types, rather than trying to enumerate wrapped or indirect callees.
    rules["no-restricted-syntax"].push(...[
      "Identifier[name=/^(require|module|exports|process|globalThis|global|__dirname|__filename|Buffer)$/]",
      "MetaProperty[meta.name='import'][property.name='meta']",
    ].map((selector) => ({ selector, message: `${message} Contracts must not reference ambient loader identifiers or import.meta.` })));
    // A computed load target cannot be checked against the contracts allowlist.
    // Retain the member-call guard too: x["require"] has no require Identifier.
    const literal = (field) => `:matches([${field}.type='Literal'][${field}.value=/^/], [${field}.type='TemplateLiteral'][${field}.expressions.length=0])`;
    rules["no-restricted-syntax"].push(...[
      `ImportExpression:not(${literal("source")})`,
      `CallExpression:matches([callee.type='Identifier'][callee.name='require'], [callee.type='MemberExpression'][callee.property.name='require'][callee.computed=false], [callee.type='MemberExpression'][callee.property.value='require'][callee.computed=true]):not(${literal("arguments.0")})`,
    ].map((selector) => ({ selector, message: `${message} Load targets must be string literals or templates without substitutions.` })));
    return rules;
  };
  return [
    // Beyond the deepest depth below, a file may not climb out of its directory at all; it still
    // may not reach a module through the package's own name or a URL.
    { files: sourceFiles(`${PLATFORM_SOURCE}/${module}/`), ignores,
      rules: boundaryRules([packageIsolation(pkg, null), packageExports, platformModuleEscapes(message)]) },
    ...Array.from({ length: MAX_PACKAGE_DEPTH - 1 }, (_, depth) => {
      const files = (extensions) => [`${PLATFORM_SOURCE}/${module}/${"*/".repeat(depth)}*.${extensions}`];
      const base = [packageIsolation(pkg, depth + 2), packageExports];
      const { graph: boundary, typeOnly } = platformModuleBoundaries(module, depth, graph);
      return [
        // No type imports in plain JavaScript: a types edge admits nothing there.
        { files: files("{js,mjs,cjs}"), ignores, rules: boundaryRules([...base, boundary, typeOnly]) },
        { files: files("{ts,tsx}"), ignores, rules: {
          ...boundaryRules([...base, boundary], [typeOnly]),
          "@typescript-eslint/no-restricted-imports": ["error", {
            patterns: typeOnly.regexes.map((regex) => ({ regex, message: typeOnly.message, caseSensitive: true, allowTypeImports: true })),
          }],
        } },
      ];
    }).flat(),
    // These complete allowlists replace the server rules, including type-only
    // edges. Beyond the bounded depths, only local ./ paths and core remain.
    { files: sourceFiles(`${PLATFORM_SOURCE}/${module}/contracts/`), ignores, rules: contractsRules(0) },
    ...Array.from({ length: MAX_PACKAGE_DEPTH - 1 }, (_, depth) => ({
      files: [`${PLATFORM_SOURCE}/${module}/contracts/${"*/".repeat(depth)}*.${SOURCE_EXTENSIONS}`],
      ignores, rules: contractsRules(depth),
    })),
  ];
}

export default tseslint.config(
  {
    ignores: [
      "**/dist",
      "coverage",
      ".worktrees",
      ".claude/worktrees",
      "test-results",
      "playwright-report",
      // Generated from the database schema.
      "src/integrations/supabase/types.ts",
    ],
  },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        tsconfigRootDir,
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.recommended.rules,
      "react-refresh/only-export-components": ["warn", { allowConstantExport: true }],
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    files: sourceFiles(),
    ignores: ["packages/**"],
    rules: boundaryRules([packageExports]),
  },
  {
    files: DOMAIN_ROOTS.flatMap((root) => sourceFiles(`${root}/`)),
    ignores: DOMAIN_TEST_FILES,
    rules: boundaryRules([packageExports, domainIsolation]),
  },
  ...workspacePackages.flatMap((pkg) => [null, ...Array.from({ length: MAX_PACKAGE_DEPTH + 1 }, (_, depth) => depth)]
    .flatMap((depth) => {
      const files = depth === null
        ? sourceFiles(`packages/${pkg.directory}/`)
        : [`packages/${pkg.directory}/${"*/".repeat(depth)}*.${SOURCE_EXTENSIONS}`];
      const isolation = packageIsolation(pkg, depth);
      const sourcePrefix = `packages/${pkg.directory}/src/`;
      return [
        { files, rules: boundaryRules([isolation, packageExports]) },
        ...(PORTABLE_PACKAGE_DIRECTORIES.includes(pkg.directory) ? [{
          // AND selectors preserve the same depth-specific package boundary.
          files: files.map((file) => [file, ...sourceFiles(sourcePrefix)]),
          ignores: testFiles(sourcePrefix),
          rules: boundaryRules([isolation, packageExports, providerIsolation]),
        }] : []),
      ];
    })),
  ...workspacePackages.filter(({ name }) => name === "@openlup/platform").flatMap((pkg) =>
    Object.keys(PLATFORM_MODULE_GRAPH).flatMap((module) => platformModuleRules(pkg, module))),
);
