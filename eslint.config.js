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
//   3. packages/<name>/: package-local; outbox may import exact public core exports;
//   4. portable package production source: additionally no provider SDK.
const SOURCE_EXTENSIONS = "{ts,tsx,js,mjs,cjs}";
const MAX_PACKAGE_DEPTH = 12;
const PORTABLE_PACKAGE_DIRECTORIES = ["core", "ui", "outbox"];
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
  message: pkg.name === "@openlup/outbox"
    ? "A file under packages/outbox stays package-local, except exact public core exports."
    : `A file under packages/${pkg.directory} imports nothing outside that directory.`,
  regexes: [
    depth === null ? "^(?:\\./)?\\.\\.(?:/|$)" : `^(?:\\./)?(?:\\.\\./){${depth}}\\.\\.(?:/|$)`,
    "^/",
    "^@/",
    "^#",
    `^@openlup/(?!(?:${escapeRegex(pkg.name.replace(/^@openlup\//, ""))}${pkg.name === "@openlup/outbox" ? "|core" : ""})(?:/|$))`,
  ],
});

function boundaryRules(boundaries) {
  const entries = boundaries.flatMap(({ message, regexes }) =>
    regexes.map((regex) => ({ regex, message })));
  return {
    "no-restricted-imports": ["error", {
      patterns: entries.map(({ regex, message }) => ({ regex, message, caseSensitive: true })),
    }],
    // Literal `import()`, `require()` and `module.require()` loads, plain
    // templates, and `import("…")` in a type position. No alias/dataflow analysis.
    // esquery's regex literal cannot contain "/", so it is \x2F.
    "no-restricted-syntax": ["error", ...entries.flatMap(({ regex, message }) => {
      const value = `/${regex.replaceAll("/", "\\x2F")}/`;
      return [
        `ImportExpression > Literal.source[value=${value}]`,
        `ImportExpression > TemplateLiteral.source[expressions.length=0] > TemplateElement[value.cooked=${value}]`,
        `TSImportType Literal[value=${value}]`,
        `CallExpression[callee.type='Identifier'][callee.name='require'] > Literal.arguments[value=${value}]`,
        `CallExpression[callee.type='Identifier'][callee.name='require'] > TemplateLiteral.arguments[expressions.length=0] > TemplateElement[value.cooked=${value}]`,
        `CallExpression[callee.type='MemberExpression'][callee.object.name='module'][callee.property.name='require'][callee.computed=false] > Literal.arguments[value=${value}]`,
        `CallExpression[callee.type='MemberExpression'][callee.object.name='module'][callee.property.name='require'][callee.computed=false] > TemplateLiteral.arguments[expressions.length=0] > TemplateElement[value.cooked=${value}]`,
      ].map((selector) => ({ selector, message }));
    })],
  };
}

const sourceFiles = (prefix = "") => [`${prefix}**/*.${SOURCE_EXTENSIONS}`];

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
);
