// Build-only declaration of the one host global a kernel contract names: the
// `AbortSignal` an outbox handler receives. Browsers, Node.js and other WHATWG
// runtimes all define it, and a consumer's own DOM or Node types supply the
// real declaration; this file is never packed. Declaring only this global keeps
// the kernel build free of the DOM and Node libraries, so no other host global
// compiles in kernel source.
interface AbortSignal {
  readonly aborted: boolean;
  readonly reason: unknown;
  throwIfAborted(): void;
}
