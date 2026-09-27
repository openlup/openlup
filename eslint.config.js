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
// for static imports and re-exports, `no-restricted-syntax` for `import()`.
// Both rules replace, not merge, their options when two config objects match a
// file, so each file set below gets one complete list:
//   1. outside packages/: a package is reached only through its declared exports;
//   2. domain code: additionally no provider SDK and no adapter, infra, runtime
//      or route-composition code (tests may compose a domain with an adapter);
//   3. packages/<name>/: nothing outside the package's own directory.
const SOURCE_EXTENSIONS = "{ts,tsx,js,mjs,cjs}";
const MAX_PACKAGE_DEPTH = 12;
const DOMAIN_ROOTS = ["src/domains", "server/domains"];
const DOMAIN_TEST_FILES = DOMAIN_ROOTS.flatMap((root) => [
  `${root}/**/*.test.${SOURCE_EXTENSIONS}`,
  `${root}/**/*.testFixtures.ts`,
]);
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

const rootImportMap = readJson("package.json").imports ?? {};
const infraImportAliases = Object.entries(rootImportMap)
  .filter(([, target]) => INFRA_DIRECTORIES.some((directory) => path.posix.normalize(target).startsWith(`${directory}/`)))
  .map(([alias]) => alias);

const packageExports = {
  message: "Import a workspace package only through a subpath its package.json `exports` declares.",
  regexes: [
    `^\\.{1,2}/(?:.*/)?packages/(?:${workspacePackages.map(({ directory }) => escapeRegex(directory)).join("|")})(?:/|$)`,
    ...workspacePackages.map(({ name, subpaths }) =>
      `^${escapeRegex(name)}(?!(?:${subpaths.join("|")})$)(?:/.*)?$`),
  ],
};

const domainIsolation = {
  message: "Domain code must not import provider SDKs or adapter, infra, runtime or route code; inject a port instead.",
  regexes: [
    "^(?:stripe|pg|openai)(?:/|$)",
    "^@(?:stripe|supabase|vercel|modelcontextprotocol)/",
    // Reached only by climbing out of the domain tree, so shared helpers such as
    // server/_lib/bff or src/lib/bff stay importable.
    `^(?:\\./)?(?:\\.\\./)+(?:server/)?(?:adapters|infra|runtime|bff|api)(?:/|$)`,
    `^(?:\\./)?(?:\\.\\./)+(?:src/)?(?:integrations|checkout/adapters)(?:/|$)`,
    "^@/(?:integrations|checkout/adapters)(?:/|$)",
    ...(infraImportAliases.length > 0 ? [`^(?:${infraImportAliases.map(escapeRegex).join("|")})$`] : []),
  ],
};

// Crossings that predate these rules. Each entry allows one exact specifier in
// one file; a new crossing fails lint, and an entry whose import is gone fails
// config load, so the list only shrinks.
const DOMAIN_ISOLATION_EXCEPTIONS = [
  { file: "server/domains/communications/newsletterProviderRegistry.ts", allow: ["../../adapters/noop_newsletter/noopNewsletterSyncAdapter.js"] },
  { file: "server/domains/payment/paymentAdapterRegistry.ts", allow: ["../../adapters/noop_payment/noopPaymentExecutionAdapter.js"] },
  { file: "src/domains/payment/components/PaymentForm.tsx", allow: ["@stripe/react-stripe-js"] },
  { file: "src/domains/payment/components/RecoveryPaymentSetupForm.tsx", allow: ["@stripe/react-stripe-js"] },
  { file: "src/domains/payment/components/StripePaymentStep.tsx", allow: ["@stripe/react-stripe-js", "@stripe/stripe-js"] },
  { file: "src/domains/payment/components/useStripePromise.ts", allow: ["@stripe/stripe-js"] },
];

for (const { file, allow } of DOMAIN_ISOLATION_EXCEPTIONS) {
  const source = existsSync(rootPath(file)) ? readFileSync(rootPath(file), "utf8") : "";
  const stale = allow.filter((specifier) => !source.includes(`"${specifier}"`));
  if (stale.length > 0) throw new Error(`Remove the stale import-boundary exception for ${file}: ${stale.join(", ")}`);
}

// `depth` is the number of directories between the package root and the file;
// a file deeper than MAX_PACKAGE_DEPTH may not climb out of its directory at all.
const packageIsolation = (pkg, depth) => ({
  message: `A file under packages/${pkg.directory} imports nothing outside that directory.`,
  regexes: [
    depth === null ? "^(?:\\./)?\\.\\.(?:/|$)" : `^(?:\\./)?(?:\\.\\./){${depth}}\\.\\.(?:/|$)`,
    "^/",
    "^@/",
    "^#",
    `^@openlup/(?!${escapeRegex(pkg.name.replace(/^@openlup\//, ""))}(?:/|$))`,
  ],
});

function boundaryRules(boundaries, allow = []) {
  const allowed = allow.length > 0 ? `(?!(?:${allow.map(escapeRegex).join("|")})$)` : "";
  const entries = boundaries.flatMap(({ message, regexes }) =>
    regexes.map((regex) => ({ regex: `${allowed}${regex}`, message })));
  return {
    "no-restricted-imports": ["error", {
      patterns: entries.map(({ regex, message }) => ({ regex, message, caseSensitive: true })),
    }],
    // `import()` with a string or a plain template, and `import("…")` in a type
    // position. esquery's regex literal cannot contain "/", so it is \x2F.
    "no-restricted-syntax": ["error", ...entries.flatMap(({ regex, message }) => {
      const value = `/${regex.replaceAll("/", "\\x2F")}/`;
      return [
        `ImportExpression > Literal.source[value=${value}]`,
        `ImportExpression > TemplateLiteral.source[expressions.length=0] > TemplateElement[value.cooked=${value}]`,
        `TSImportType Literal[value=${value}]`,
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
  ...DOMAIN_ISOLATION_EXCEPTIONS.map(({ file, allow }) => ({
    files: [file],
    rules: boundaryRules([packageExports, domainIsolation], allow),
  })),
  ...workspacePackages.flatMap((pkg) => [
    { files: sourceFiles(`packages/${pkg.directory}/`), rules: boundaryRules([packageIsolation(pkg, null)]) },
    ...Array.from({ length: MAX_PACKAGE_DEPTH + 1 }, (_, depth) => ({
      files: [`packages/${pkg.directory}/${"*/".repeat(depth)}*.${SOURCE_EXTENSIONS}`],
      rules: boundaryRules([packageIsolation(pkg, depth)]),
    })),
  ]),
);
