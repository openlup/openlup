// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/dom';
import { operatorPage } from '../../examples/neutral-store/client/pages/operator.ts';
import { configurations } from '../../examples/neutral-store/owned/store.config.ts';
import { fragments } from '../../examples/neutral-store/owned/fragments.ts';
import type { PageContext } from '../../examples/neutral-store/client/context.ts';

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function openDraftForm() {
  const context: PageContext = {
    config: configurations.supplements, locale: 'en', route: { key: 'admin', locale: 'en' },
    query: new URLSearchParams(), fragments, t: key => key, money: String,
    getCart: () => { throw new Error('Operator form does not read the cart'); },
    setCart() {}, navigate() {},
  };
  document.body.append(operatorPage(context));
  const form = document.querySelector<HTMLFormElement>('#catalogue-drafts form:has([name=payload])')!;
  const payload = form.querySelector<HTMLTextAreaElement>('[name=payload]')!;
  const save = () => form.requestSubmit();
  const json = (value: unknown) => new Response(JSON.stringify(value));
  let pin = 101;
  const reads = vi.fn((version: number) => Promise.resolve(json({ ok: true,
    value: { type: { key: 'starter:item', version: version === 1 ? pin : 303 } } })));
  const writes: { key: string; body: string }[] = [];
  const first = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn((_url: string, init: RequestInit) => {
    const body = String(init.body), input = JSON.parse(body);
    if (input.action === 'example') return reads(input.type.version);
    writes.push({ key: new Headers(init.headers).get('Idempotency-Key')!, body });
    return writes.length === 1 ? first.promise : Promise.resolve(json({ ok: true, value: { outcome: 'replayed' } }));
  }));
  const edit = (value: string) => {
    payload.value = value;
    payload.dispatchEvent(new Event('input', { bubbles: true }));
  };
  const start = async () => { save(); await waitFor(() => expect(writes).toHaveLength(1)); };
  const idle = () => waitFor(() => expect(form.querySelector('button[type=submit]')).not.toBeDisabled());
  return { form, payload, edit, reads, writes, start, save, idle, first, nextPin: () => { pin = 202; }, json };
}

it('retries the exact dispatched bytes even when the lost response was stale', async () => {
  const { form, start, first, idle, nextPin, save, writes, reads } = openDraftForm();
  await start();
  expect(writes[0]!.key).toMatch(/^pin:/u);
  const parent = form.parentElement!;
  form.remove();
  first.reject(new Error('response lost'));
  await idle();
  parent.append(form);
  nextPin();
  save();
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]).toEqual(writes[0]);
  expect(reads).toHaveBeenCalledTimes(1);
});

it('uses a fresh pair after edit and restore, a version change, or a new action', async () => {
  const { form, payload, edit, start, first, idle, nextPin, save, writes } = openDraftForm();
  await start();
  const original = payload.value;
  edit(original + ' ');
  edit(original);
  first.reject(new Error('response lost'));
  await idle();
  nextPin();
  save();
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]!.key).not.toBe(writes[0]!.key);
  expect(JSON.parse(writes[1]!.body).payload.product.type.version).toBe(202);
  await idle();
  // The signature also catches a selection made without a DOM edit event.
  const changed = JSON.parse(original);
  changed.product.type.version = 2;
  payload.value = JSON.stringify(changed);
  save();
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(writes[2]!.key).not.toBe(writes[1]!.key);
  expect(JSON.parse(writes[2]!.body).payload.product.type.version).toBe(303);
  await idle();
  form.querySelector<HTMLButtonElement>('button[type=button]')!.click();
  save();
  await waitFor(() => expect(writes).toHaveLength(4));
  expect(writes[3]!.key).not.toBe(writes[2]!.key);
});

it.each([true, false])('discards an edited preflight with ok=%s', async ok => {
  const { form, payload, edit, reads, save, idle, writes, json } = openDraftForm();
  const result = deferred<Response>();
  reads.mockReturnValueOnce(result.promise);
  save();
  expect(reads).toHaveBeenCalledTimes(1);
  edit(payload.value + ' ');
  result.resolve(json(ok ? { ok, value: { type: { key: 'starter:item', version: 101 } } }
    : { ok, code: 'catalog_type_not_installed' }));
  await idle();
  expect(writes).toHaveLength(0);
  expect(form.textContent).not.toMatch(/starter:item@101|catalog_type_not_installed/u);
});
