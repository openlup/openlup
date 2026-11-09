import type { imageIo } from './ci-image-pull.mjs';
export interface BrowserOptions { manifest: string; commit: string; localImage?: string }
export function parseArguments(args: string[]): BrowserOptions;
export function resolveBrowserImage(io?: typeof imageIo, localImage?: string): Promise<string>;
export function withCleanup<T>(work: (defer: (release: () => unknown | Promise<unknown>) => void) => Promise<T>): Promise<T>;
export function withConnectionCleanup<T>(work: (defer: (release: () => unknown | Promise<unknown>) => void, guard: <C extends { on(event: 'error', listener: (error: Error) => void): unknown }>(connection: C) => C, recordLoss: (code: string) => void) => Promise<T>): Promise<T>;
export function scanPrivateOutput(output: string, privateValues?: string[]): void;
export function browserArguments(app: string, reference: string, name: string, localImage?: string): string[];
export function runStarterBrowser(options: BrowserOptions): Promise<void>;
export function acquireStarterPostgres(defer: (release: () => Promise<unknown>) => void, io?: {
  start: typeof import('../tests/helpers/postgresContainer.ts').runPostgresContainer;
  ready: typeof import('../tests/helpers/postgresContainer.ts').waitForPostgresTcpReady;
}): Promise<import('../tests/helpers/postgresContainer.ts').PostgresContainer & { password: string }>;
export function capturePrivateValues(message: Record<string, unknown>): string[];
export interface CareBrowserFixture { id: string; baseURL: string; ownerUrl: string; runtimeUrl: string; state: string }
export function writeBrowserFixtures(app: string, entries: CareBrowserFixture[]): Promise<void>;
export function watchStarterHost(child: import('node:child_process').ChildProcess, configuration: string,
  defer: (release: () => Promise<void>) => void, recordLoss: (code: string) => void): () => boolean;
