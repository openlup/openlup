// Real-browser witness of the storefront page handle from the installed package: anchor visibility and request
// interception, against static markup and a loopback server this spec starts. It needs no store host or database.
// CI: titles start "page handle:", so the file runs in the remainder browser group; every case is independent of the
// store configuration, so it runs in the first project only (about 5 s).
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect, type Page } from '@playwright/test';
import { createPageHandle } from '@openlup/platform/storefront/testing';

const markup = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; font: 16px sans-serif; } .box { display: block; width: 120px; height: 40px; margin: 4px; }
</style></head><body>
  <button class="box" data-openlup-action="case_visible">Visible</button>
  <div class="box" data-openlup-state="case_display_none" style="display: none"></div>
  <div class="box" data-openlup-state="case_visibility_hidden" style="visibility: hidden"></div>
  <div style="opacity: 0"><div class="box" data-openlup-state="case_transparent"></div></div>
  <div class="box" data-openlup-state="case_hidden_attribute" hidden></div>
  <div class="box" data-openlup-state="case_outside" style="position: absolute; left: -2000px; top: 0"></div>
  <div style="position: relative; width: 120px; height: 40px">
    <div class="box" data-openlup-state="case_covered" style="margin: 0"></div>
    <div style="position: absolute; inset: 0; background: #fff"></div>
  </div>
  <button class="box" data-openlup-action="case_child_hit" style="padding: 0"><span style="display: block; width: 100%; height: 100%">Child</span></button>
  <div style="position: relative; width: 200px; height: 80px; background: #eee">
    <span data-openlup-state="case_ancestor_hit" style="pointer-events: none">Text</span>
  </div>
  <button class="box" id="plain">Plain</button>
  <div style="height: 3000px"></div>
  <div class="box" data-openlup-state="case_below_fold"></div>
</body></html>`;

const purchase = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <output id="outcome">idle</output>
  <button data-openlup-action="place_order" onclick="
    document.getElementById('outcome').textContent = 'sent';
    fetch('/api/create?token=private', { method: 'POST', headers: { 'Idempotency-Key': 'key-1' } })
      .then(response => response.text())
      .then(() => { document.getElementById('outcome').textContent = 'answered'; },
            () => { document.getElementById('outcome').textContent = 'failed'; });
  ">Place order</button>
</body></html>`;

// The server answers a create 600 ms after receiving it, well after the 100 ms quiet window below.
const answerDelayMs = 600;
let server: Server, origin: string;
const served = { received: 0, answered: 0 };

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/purchase') { response.writeHead(200, { 'content-type': 'text/html' }).end(purchase); return; }
    if (request.method === 'POST' && request.url?.startsWith('/api/create')) {
      served.received++;
      setTimeout(() => { served.answered++; response.writeHead(201, { 'content-type': 'text/plain' }).end('created'); }, answerDelayMs);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => { await new Promise(resolve => server.close(resolve)); });
test.beforeEach(() => {
  const info = test.info();
  test.skip(info.project.name !== info.config.projects[0]?.name, 'independent of the store configuration');
  served.received = 0; served.answered = 0;
});

async function visibilityPage(page: Page) {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(markup);
  return createPageHandle(page);
}

const visible = { insideScrollArea: true, hidden: false, transparent: false, coveredAtCentre: false };

test('page handle: measures each visibility case in a real layout', async ({ page }) => {
  const handle = await visibilityPage(page);
  const find = (attribute: 'state' | 'action', value: string) => handle.find({ attribute, value }, { timeoutMs: 1_000 });
  expect(await find('action', 'case_visible')).toEqual({ width: 120, height: 40, ...visible });
  expect(await find('state', 'case_display_none')).toMatchObject({ width: 0, height: 0, hidden: true });
  expect(await find('state', 'case_visibility_hidden')).toMatchObject({ hidden: true });
  expect(await find('state', 'case_transparent')).toMatchObject({ transparent: true, hidden: false });
  expect(await find('state', 'case_hidden_attribute')).toMatchObject({ hidden: true });
  expect(await find('state', 'case_below_fold')).toEqual({ width: 120, height: 40, ...visible });
  expect(await find('state', 'case_outside')).toMatchObject({ insideScrollArea: false, hidden: false });
  expect(await find('state', 'case_covered')).toMatchObject({ coveredAtCentre: true, hidden: false, transparent: false, insideScrollArea: true });
  expect(await find('action', 'case_child_hit')).toEqual({ width: 120, height: 40, ...visible });
  expect(await find('state', 'case_ancestor_hit')).toMatchObject(visible);
  expect(await find('state', 'case_absent')).toBeNull();
  expect(handle.width()).toBe(800);
});

test('page handle: lists only visible anchors, with custom locators replacing attribute anchors', async ({ page }) => {
  const handle = await visibilityPage(page);
  expect(await handle.anchors()).toEqual(['action:case_child_hit', 'action:case_visible', 'state:case_ancestor_hit', 'state:case_below_fold']);
  expect(await handle.anchors({ 'action:case_visible': '#absent', 'state:case_plain': '#plain', 'state:case_covered': '[data-openlup-state="case_covered"]' }))
    .toEqual(['action:case_child_hit', 'state:case_ancestor_hit', 'state:case_below_fold', 'state:case_plain']);
  expect(await page.evaluate(() => [window.scrollX, window.scrollY]), 'the scroll position is restored').toEqual([0, 0]);
});

test('page handle: a withheld create reaches the server, the page sees a failure, and settling waits for it', async ({ page }) => {
  const handle = createPageHandle(page, { origin });
  await handle.navigate('/purchase');
  const seen: Array<{ method: string; path: string; key: string | null }> = [];
  const remove = await handle.intercept(request => {
    seen.push({ method: request.method, path: request.path, key: request.header('Idempotency-Key') });
    return request.path === '/api/create' ? 'withhold' : 'pass';
  });
  expect(await handle.perform({ attribute: 'action', value: 'place_order' }, { timeoutMs: 2_000 })).toBe(true);
  await handle.settled({ quietMs: 100 });
  expect(served).toEqual({ received: 1, answered: 1 });
  await expect(page.locator('#outcome')).toHaveText('failed');
  expect(seen).toEqual([{ method: 'POST', path: '/api/create', key: 'key-1' }]);
  expect(handle.path()).toBe('/purchase');
  await remove();
});

test('page handle: a passed create settles only after its answer arrived', async ({ page }) => {
  const handle = createPageHandle(page, { origin });
  await handle.navigate('/purchase');
  const remove = await handle.intercept(() => 'pass');
  await handle.perform({ attribute: 'action', value: 'place_order' }, { timeoutMs: 2_000 });
  await handle.settled({ quietMs: 100 });
  expect(served).toEqual({ received: 1, answered: 1 });
  await expect(page.locator('#outcome')).toHaveText('answered');
  await remove();
});

test('page handle: a blocked create never reaches the server, and a removed interceptor routes nothing', async ({ page }) => {
  const handle = createPageHandle(page, { origin });
  await handle.navigate('/purchase');
  const remove = await handle.intercept(request => request.path === '/api/create' ? 'block' : 'pass');
  await handle.perform({ attribute: 'action', value: 'place_order' }, { timeoutMs: 2_000 });
  await handle.settled({ quietMs: 100 });
  await expect(page.locator('#outcome')).toHaveText('failed');
  expect(served.received).toBe(0);
  await remove();
  await handle.reload();
  await handle.perform({ attribute: 'action', value: 'place_order' }, { timeoutMs: 2_000 });
  await expect(page.locator('#outcome')).toHaveText('answered', { timeout: 5_000 });
  expect(served).toEqual({ received: 1, answered: 1 });
});
