import type { imageIo } from './ci-image-pull.mjs';
export interface BrowserOptions { manifest: string; commit: string; port: string; localImage?: string }
export function parseArguments(args: string[]): BrowserOptions;
export function resolveBrowserImage(io?: typeof imageIo, localImage?: string): Promise<string>;
export function withCleanup<T>(work: (defer: (release: () => unknown | Promise<unknown>) => void) => Promise<T>): Promise<T>;
export function scanPrivateOutput(output: string, privateValues?: string[]): void;
export function browserArguments(app: string, reference: string, name: string, localImage?: string): string[];
export function runStarterBrowser(options: BrowserOptions): Promise<void>;
