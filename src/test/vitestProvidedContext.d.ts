import type { DurationSections } from "../../scripts/ci-vitest-duration-keys.ts";

// Values vitest.config.ts provides to every test worker, read with `inject()`.
//
// Kept in its own type-only file on purpose. A `declare module "vitest"` augmentation
// makes its file part of every vitest importer's program, and `src/test/setup.ts`
// imports far into the app (up to the locale JSON modules). While the augmentation
// lived there, any locale JSON edit invalidated the whole incremental app typecheck.
// This file's closure is one small scripts module.
declare module "vitest" {
  interface ProvidedContext {
    coverageRun: boolean;
    durationManifest: DurationSections;
    repositoryRoot: string;
  }
}
