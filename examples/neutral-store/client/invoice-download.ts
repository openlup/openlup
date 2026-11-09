import { isRecord } from '../shared/offer.ts';

/** The POST response contains only an already-owned PDF, never a public ticket. */
export function downloadInvoice(value: unknown): void {
  if (!isRecord(value) || value.contentType !== 'application/pdf' || typeof value.fileName !== 'string'
    || !/^[^/\\\r\n]+\.pdf$/i.test(value.fileName) || typeof value.base64 !== 'string') return;
  const bytes = Uint8Array.from(atob(value.base64), character => character.charCodeAt(0));
  const url = URL.createObjectURL(new Blob([bytes], { type: value.contentType }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = value.fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Give the browser its download task before releasing the local capability.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
