import { PassThrough } from "node:stream";
import type { ReactElement } from "react";
import { renderToPipeableStream } from "react-dom/server";

export class StaticRenderTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Static React render did not complete within ${timeoutMs}ms`);
    this.name = "StaticRenderTimeoutError";
  }
}

interface CompleteRenderOptions {
  timeoutMs?: number;
  onError?: (error: Error) => void;
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

/**
 * Resolve the complete React tree, including every lazy/Suspense boundary.
 * Any render or stream error rejects the route; callers never receive partial
 * markup that a static generator could accidentally publish.
 */
export function renderCompleteReactHtml(
  element: ReactElement,
  { timeoutMs = 15_000, onError }: CompleteRenderOptions = {},
): Promise<string> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(new RangeError("Static render timeout must be greater than zero"));
  }

  return new Promise((resolve, reject) => {
    const output = new PassThrough();
    const chunks: Buffer[] = [];
    let settled = false;
    let abortRender = () => {};

    const finishWithError = (value: unknown) => {
      if (settled) return;
      settled = true;
      const error = asError(value);
      clearTimeout(timeout);
      onError?.(error);
      abortRender();
      output.destroy();
      reject(error);
    };

    const timeout = setTimeout(
      () => finishWithError(new StaticRenderTimeoutError(timeoutMs)),
      timeoutMs,
    );

    output.on("data", (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    output.on("error", finishWithError);
    output.on("end", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      // React 18's pipeable renderer can pad a multi-byte text boundary with NUL
      // bytes when a non-ASCII glyph lands at the edge of its internal chunk.
      // NUL is never valid HTML text and made the generated homepage a binary
      // document, so strip that transport padding before the route is validated.
      resolve(Buffer.concat(chunks).toString("utf8").replace(/\0/g, ""));
    });

    const stream = renderToPipeableStream(element, {
      onAllReady() {
        if (!settled) stream.pipe(output);
      },
      onShellError: finishWithError,
      onError: finishWithError,
    });
    abortRender = stream.abort;
  });
}
