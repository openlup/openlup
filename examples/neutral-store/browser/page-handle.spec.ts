// Real-browser witness of the storefront page handle from the installed package: anchor visibility and request
// interception, against static markup and a loopback server this spec starts. It needs no store host or database.
// CI: titles start "page handle:", so the file runs in the remainder browser group; every case is independent of the
// store configuration, so it runs in the first project only (about 15 s, mostly the visibility table's pages).
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
  <div style="position: relative; width: 200px; height: 40px">
    <span style="position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap">
      <span data-openlup-state="case_visually_hidden">Order confirmed</span>
    </span>
  </div>
  <div style="clip-path: inset(50%); width: 200px; height: 40px"><button class="box" data-openlup-action="case_clip_path">Clipped</button></div>
  <div id="carousel" style="width: 200px; height: 50px; overflow: hidden">
    <div style="height: 50px">First slide</div>
    <div style="height: 50px"><div class="box" style="height: 20px" data-openlup-state="case_second_slide"></div></div>
  </div>
  <div id="list" style="width: 200px; height: 50px; overflow: auto">
    <div style="height: 100px">Earlier items</div>
    <div class="box" style="height: 20px" data-openlup-state="case_scrolled_list"></div>
  </div>
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
  <button data-openlup-action="redirect" onclick="
    fetch('/api/redirect', { method: 'POST' }).then(response => response.text())
      .then(() => { document.getElementById('outcome').textContent = 'landed'; });
  ">Redirect</button>
</body></html>`;

// The server answers a create 600 ms after receiving it, well after the 100 ms quiet window below.
const answerDelayMs = 600;
let server: Server, origin: string;
const served = { received: 0, answered: 0, landed: 0 };
const streams = new Set<import('node:http').ServerResponse>();
const streamPage = `<!doctype html><html><head><meta charset="utf-8"></head><body>
  <output id="stream">waiting</output>
  <script>new EventSource('/events?topic=order').onmessage = event => { document.getElementById('stream').textContent = event.data; };</script>
</body></html>`;

test.beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url === '/purchase') { response.writeHead(200, { 'content-type': 'text/html' }).end(purchase); return; }
    if (request.url === '/stream') { response.writeHead(200, { 'content-type': 'text/html' }).end(streamPage); return; }
    // A server-sent event stream that never ends, as an order-status or chat widget keeps open.
    if (request.url?.startsWith('/events')) {
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store' });
      response.write('data: open\n\n');
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    if (request.method === 'POST' && request.url?.startsWith('/api/create')) {
      served.received++;
      setTimeout(() => { served.answered++; response.writeHead(201, { 'content-type': 'text/plain' }).end('created'); }, answerDelayMs);
      return;
    }
    if (request.method === 'POST' && request.url === '/api/redirect') { response.writeHead(303, { location: '/api/landing' }).end(); return; }
    if (request.url === '/api/landing') {
      setTimeout(() => { served.landed++; response.writeHead(200, { 'content-type': 'text/plain' }).end('landed'); }, answerDelayMs);
      return;
    }
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
test.afterAll(async () => {
  for (const stream of streams) stream.end();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});
test.beforeEach(() => {
  const info = test.info();
  test.skip(info.project.name !== info.config.projects[0]?.name, 'independent of the store configuration');
  served.received = 0; served.answered = 0; served.landed = 0;
});

async function visibilityPage(page: Page) {
  await page.setViewportSize({ width: 800, height: 600 });
  await page.setContent(markup);
  return createPageHandle(page);
}


// One table of visibility cases, each its own page at 800 × 600: what a buyer sees decides `visible`, and the
// measurement must leave every scroll position as it found it at once (scroll-behavior: smooth included).
// `visible` is a non-zero box inside the scroll area, not hidden, not transparent and not covered at its centre.
const visibilityTable: readonly {
  name: string; html: string; scroll?: readonly [number, number]; dpr?: number;
  expect: { visible: boolean; insideScrollArea: boolean; coveredAtCentre: boolean };
}[] = [
  { name: "plain visible anchor", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><button id=\"t\" style=\"width:60px;height:40px;background:#ddd\">x</button><div style=\"height:2000px\"></div></body></html>" },
  { name: "display none", expect: { visible: false, insideScrollArea: true, coveredAtCentre: true },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><div id=\"t\" style=\"display:none;width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "visibility hidden", expect: { visible: false, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><div id=\"t\" style=\"visibility:hidden;width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "opacity 0 on an ancestor", expect: { visible: false, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><div style=\"opacity:0\"><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "hidden attribute", expect: { visible: false, insideScrollArea: true, coveredAtCentre: true },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><div id=\"t\" hidden style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "covered by an overlay", expect: { visible: false, insideScrollArea: true, coveredAtCentre: true },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><div style=\"position:relative;width:60px;height:40px\"><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"position:absolute;inset:0;background:#fff\"></div></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "centre hits a child", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><button id=\"t\" style=\"width:60px;height:40px;background:#ddd;padding:0\"><span style=\"display:block;width:100%;height:100%\">c</span></button><div style=\"height:2000px\"></div></body></html>" },
  { name: "the hit is a positioned ancestor", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><div style=\"position:relative;width:200px;height:80px;background:#eee\"><span id=\"t\" style=\"pointer-events:none\">Text</span></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "outside the scroll area to the left", expect: { visible: false, insideScrollArea: false, coveredAtCentre: true },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><div id=\"t\" style=\"position:absolute;left:-2000px;top:0;width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "further down a list the buyer can scroll", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0\"><div style=\"width:200px;height:50px;overflow:auto\"><div style=\"height:100px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd;height:20px\"></div></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "root overflow-x hidden with smooth scrolling, anchor below the fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow-x:hidden;scroll-behavior:smooth\"><body style=\"margin:0\"><div style=\"height:2500px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "fixed cart bar inside a short overflow: hidden wrapper under smooth scrolling", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow-y:scroll;scroll-behavior:smooth\"><body style=\"margin:0\"><div style=\"overflow:hidden;height:8px\"><div id=\"t\" style=\"position:fixed;left:0;bottom:0;width:230px;height:36px;background:#ccc\"></div></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "drawer html overflow-x hidden", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow-x:hidden\"><body style=\"margin:0;position:relative;\"><header style=\"position:relative;height:60px\"><a id=\"t\" style=\"position:absolute;left:730px;top:10px;width:60px;height:40px;background:#ddd\">Cart</a></header><nav style=\"position:absolute;left:100%;top:0;width:300px;height:400px\">Menu</nav><div style=\"height:3000px\"></div></body></html>" },
  { name: "drawer body overflow-x hidden", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"\"><body style=\"margin:0;position:relative;overflow-x:hidden\"><header style=\"position:relative;height:60px\"><a id=\"t\" style=\"position:absolute;left:730px;top:10px;width:60px;height:40px;background:#ddd\">Cart</a></header><nav style=\"position:absolute;left:100%;top:0;width:300px;height:400px\">Menu</nav><div style=\"height:3000px\"></div></body></html>" },
  { name: "body lock in-flow anchor y500", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0;overflow:hidden\"><div style=\"height:500px\"></div><div id=\"t\" style=\"width:120px;height:40px;background:#ddd\"></div><div style=\"height:3000px\"></div></body></html>" },
  { name: "app shell html hidden below fold", expect: { visible: false, insideScrollArea: false, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow:hidden;height:100%\"><body style=\"margin:0;height:100%\"><main style=\"height:100%\">S</main><button id=\"t\" style=\"display:block;width:120px;height:40px\">B</button></body></html>" },
  { name: "html overflow-y hidden below fold", expect: { visible: false, insideScrollArea: false, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow-y:hidden\"><body style=\"margin:0\"><div style=\"height:3000px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:600px\"></div></body></html>" },
  { name: "body lock below fold", expect: { visible: false, insideScrollArea: false, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0;overflow:hidden\"><div style=\"height:3000px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:600px\"></div></body></html>" },
  { name: "partially visible at viewport bottom edge, scrollable page", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"height:580px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "half shown at the viewport bottom edge under a body scroll lock", expect: { visible: false, insideScrollArea: false, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0;overflow:hidden\"><div style=\"height:580px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "partially visible at right edge of auto container", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"width:300px;overflow-x:auto;white-space:nowrap\"><div style=\"display:inline-block;width:270px\"></div><div id=\"t\" style=\"display:inline-block;width:60px;height:40px;background:#ddd\"></div></div></body></html>" },
  { name: "scroll container below fold of scrollable page, anchor below its fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"height:1500px\"></div><div style=\"height:200px;overflow:auto\"><div style=\"height:600px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:600px\"></div></div><div style=\"height:1500px\"></div></body></html>" },
  { name: "app shell body hidden, main overflow auto, anchor below main fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"height:100%\"><body style=\"margin:0;height:100%;overflow:hidden\"><main style=\"height:100%;overflow-y:auto\"><div style=\"height:2000px\"></div><button id=\"t\" style=\"display:block;width:120px;height:40px\">B</button><div style=\"height:500px\"></div></main></body></html>" },
  { name: "app shell html hidden 100vh, #app overflow auto, anchor below fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow:hidden;height:100%\"><body style=\"margin:0;height:100%\"><div style=\"height:100vh;overflow:auto\"><div style=\"height:1500px\"></div><button id=\"t\" style=\"display:block;width:120px;height:40px\">B</button></div></body></html>" },
  { name: "drawer under html overflow-x hidden, anchor below fold (y scrollable)", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow-x:hidden\"><body style=\"margin:0;position:relative\"><nav style=\"position:absolute;left:100%;top:0;width:300px;height:400px\">M</nav><div style=\"height:2000px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:500px\"></div></body></html>" },
  { name: "drawer under body overflow-x hidden, anchor below fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0;position:relative;overflow-x:hidden\"><nav style=\"position:absolute;left:100%;top:0;width:300px;height:400px\">M</nav><div style=\"height:2000px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:500px\"></div></body></html>" },
  { name: "drawer nav beyond the viewport under html overflow-x hidden", expect: { visible: false, insideScrollArea: false, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow-x:hidden\"><body style=\"margin:0;position:relative;\"><header style=\"position:relative;height:60px\"><a style=\"position:absolute;left:730px;top:10px;width:60px;height:40px;background:#ddd\">Cart</a></header><nav id=\"t\" style=\"position:absolute;left:100%;top:0;width:300px;height:400px\">Menu</nav><div style=\"height:3000px\"></div></body></html>" },
  { name: "hidden carousel slide (overflow hidden container)", expect: { visible: false, insideScrollArea: false, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"width:300px;height:100px;overflow:hidden\"><div style=\"height:100px\">one</div><div id=\"t\" style=\"height:100px;background:#ddd\">two</div></div></body></html>" },
  { name: "horizontal carousel hidden slide overflow-x hidden", expect: { visible: false, insideScrollArea: false, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"width:300px;overflow:hidden;display:flex\"><div style=\"flex:0 0 300px;height:100px\">one</div><div id=\"t\" style=\"flex:0 0 300px;height:100px;background:#ddd\">two</div></div></body></html>" },
  { name: "sr-only", expect: { visible: false, insideScrollArea: true, coveredAtCentre: true },
    html: "<!doctype html><html><body><span id=\"t\" style=\"position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap\">x</span></body></html>" },
  { name: "clip-path inset 50%", expect: { visible: false, insideScrollArea: true, coveredAtCentre: true },
    html: "<!doctype html><html><body><div style=\"clip-path:inset(50%)\"><button id=\"t\" style=\"width:60px;height:40px;background:#ddd\">x</button></div></body></html>" },
  { name: "fixed escapes overflow hidden", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body><div style=\"overflow:hidden;height:8px\"><div id=\"t\" style=\"position:fixed;left:0;bottom:0;width:60px;height:40px;background:#ddd\"></div></div><div style=\"height:3000px\"></div></body></html>" },
  { name: "absolute escapes overflow hidden", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body><div style=\"position:relative;height:100px\"><div style=\"overflow:hidden;height:20px\"><div id=\"t\" style=\"position:absolute;top:60px;width:60px;height:40px;background:#ddd\"></div></div></div></body></html>" },
  { name: "root overflow-x hidden below fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow-x:hidden\"><body style=\"margin:0\"><div style=\"height:3000px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:100px\"></div></body></html>" },
  { name: "root overflow-y scroll below fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"overflow-y:scroll\"><body style=\"margin:0\"><div style=\"height:3000px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:100px\"></div></body></html>" },
  { name: "sticky header, anchor below fold (centre scroll)", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><header style=\"position:sticky;top:0;height:80px;background:#000;z-index:2\"></header><div style=\"height:2000px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "sticky header on a scrolled page, anchor in view below it", scroll: [0, 500], expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><header style=\"position:sticky;top:0;height:80px;background:#000;z-index:2\"></header><div style=\"height:520px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "fixed header covering in-view anchor fully", expect: { visible: false, insideScrollArea: true, coveredAtCentre: true },
    html: "<!doctype html><html><body style=\"margin:0\"><header style=\"position:fixed;top:0;left:0;right:0;height:80px;background:#000;z-index:2\"></header><div style=\"height:20px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:2000px\"></div></body></html>" },
  { name: "nested locked: outer hidden, inner hidden, anchor shown", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"height:300px;overflow:hidden\"><div style=\"height:200px;overflow:hidden\"><div style=\"height:150px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:500px\"></div></div><div style=\"height:500px\"></div></div></body></html>" },
  { name: "nested locked: inner hidden, anchor below inner fold", expect: { visible: false, insideScrollArea: false, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"height:300px;overflow:hidden\"><div style=\"height:200px;overflow:hidden\"><div style=\"height:250px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div></div><div style=\"height:500px\"></div></div></body></html>" },
  { name: "auto inside locked: outer hidden 300, inner auto, anchor below inner fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"height:300px;overflow:hidden\"><div style=\"height:200px;overflow:auto\"><div style=\"height:250px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div></div><div style=\"height:500px\"></div></div></body></html>" },
  { name: "locked container below fold of scrollable page, anchor shown within it", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"height:2000px\"></div><div style=\"height:200px;overflow:hidden\"><div style=\"height:50px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:600px\"></div></div><div style=\"height:500px\"></div></body></html>" },
  { name: "RTL page, anchor at far left below fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html dir=\"rtl\"><body style=\"margin:0\"><div style=\"width:2000px;height:2000px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:500px\"></div></body></html>" },
  { name: "RTL page scrolled left, anchor in view", scroll: [-600, 0], expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html dir=\"rtl\"><body style=\"margin:0\"><div style=\"width:2000px;height:100px\"></div><div id=\"t\" style=\"margin-right:700px;width:60px;height:40px;background:#ddd\"></div></body></html>" },
  { name: "RTL scroll container auto, anchor off-left", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html dir=\"rtl\"><body style=\"margin:0\"><div style=\"width:300px;overflow-x:auto;white-space:nowrap\"><div style=\"display:inline-block;width:600px;height:10px\"></div><div id=\"t\" style=\"display:inline-block;width:60px;height:40px;background:#ddd\"></div></div></body></html>" },
  { name: "RTL overflow-x hidden carousel, hidden slide", expect: { visible: false, insideScrollArea: false, coveredAtCentre: false },
    html: "<!doctype html><html dir=\"rtl\"><body style=\"margin:0\"><div style=\"width:300px;overflow:hidden;display:flex\"><div style=\"flex:0 0 300px;height:100px\">one</div><div id=\"t\" style=\"flex:0 0 300px;height:100px;background:#ddd\">two</div></div></body></html>" },
  { name: "dpr 2 below fold", dpr: 2, expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"height:3000px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:100px\"></div></body></html>" },
  { name: "css zoom 1.5 body lock in view", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"zoom:1.5\"><body style=\"margin:0;overflow:hidden\"><div style=\"height:200px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:3000px\"></div></body></html>" },
  { name: "css zoom 1.37, sub-pixel anchor at the bottom edge of a scrollable page", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html style=\"zoom:1.37\"><body style=\"margin:0\"><div style=\"height:3000.3px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div></body></html>" },
  { name: "body lock, anchor exactly fills to bottom", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0;overflow:hidden\"><div style=\"height:560px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div><div style=\"height:3000px\"></div></body></html>" },
  { name: "body lock modal fixed open, cta in modal", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0;overflow:hidden\"><div style=\"height:3000px\"></div><div style=\"position:fixed;inset:0;display:grid;place-items:center\"><div style=\"height:300px;overflow:auto\"><button id=\"t\" style=\"width:60px;height:40px;background:#ddd\">Pay</button></div></div></body></html>" },
  { name: "body lock modal with overflow-auto dialog, cta below dialog fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0;overflow:hidden\"><div style=\"height:3000px\"></div><div style=\"position:fixed;inset:0;overflow:auto\"><div style=\"height:1200px\"></div><button id=\"t\" style=\"width:60px;height:40px;background:#ddd\">Pay</button><div style=\"height:100px\"></div></div></body></html>" },
  { name: "auto inside locked: outer hidden 300, inner auto 200, anchor below both folds", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"height:300px;overflow:hidden\"><div style=\"height:200px;overflow:auto\"><div style=\"height:400px\"></div><div id=\"t\" style=\"width:60px;height:40px;background:#ddd\"></div></div><div style=\"height:500px\"></div></div></body></html>" },
  { name: "inside a closed details element", expect: { visible: false, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><details><summary>Plans</summary><div><button id=\"t\">Subscribe</button></div></details></body></html>" },
  { name: "inside an open details element", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><details open><summary>Plans</summary><div><button id=\"t\">Subscribe</button></div></details></body></html>" },
  { name: "inside a content-visibility: hidden section", expect: { visible: false, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body><section style=\"content-visibility:hidden\"><button id=\"t\">Subscribe</button></section></body></html>" },
  { name: "inside a content-visibility: auto section below the fold", expect: { visible: true, insideScrollArea: true, coveredAtCentre: false },
    html: "<!doctype html><html><body style=\"margin:0\"><div style=\"height:3000px\"></div><section style=\"content-visibility:auto;contain-intrinsic-size:auto 200px\"><button id=\"t\" style=\"width:60px;height:40px\">Subscribe</button></section><div style=\"height:3000px\"></div></body></html>" },
  { name: "inside an open shadow root (stated limit: measured as covered)", expect: { visible: false, insideScrollArea: true, coveredAtCentre: true },
    html: "<!doctype html><html><body style=\"margin:0\"><div id=\"host\"></div><div style=\"height:2000px\"></div><script>document.getElementById('host').attachShadow({ mode: 'open' }).innerHTML = '<button id=\"t\" style=\"width:60px;height:40px\">Buy</button>';</script></body></html>" },
];

for (const row of visibilityTable) {
  test(`page handle: visibility table: ${row.name}`, async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 800, height: 600 }, deviceScaleFactor: row.dpr ?? 1 });
    try {
      const page = await context.newPage();
      await page.setContent(row.html);
      if (row.scroll) await page.evaluate(([x, y]) => window.scrollTo(x, y), row.scroll);
      const snapshot = () => page.evaluate(() => [window.scrollX, window.scrollY,
        ...[...document.querySelectorAll('*')].map(node => `${node.scrollLeft},${node.scrollTop}`)].join(' '));
      const before = await snapshot();
      const measured = await createPageHandle(page).find({ locator: '#t' }, { timeoutMs: 1_000 });
      expect(measured).not.toBeNull();
      const { width, height, insideScrollArea, hidden, transparent, coveredAtCentre } = measured!;
      const shown = width > 0 && height > 0 && insideScrollArea && !hidden && !transparent && !coveredAtCentre;
      expect({ visible: shown, insideScrollArea, coveredAtCentre }).toEqual(row.expect);
      expect(await snapshot(), 'every scroll position is restored at once').toBe(before);
    } finally {
      await context.close();
    }
  });
}

test('page handle: lists only visible anchors, with custom locators replacing attribute anchors', async ({ page }) => {
  const handle = await visibilityPage(page);
  expect(await handle.anchors()).toEqual(['action:case_child_hit', 'action:case_visible', 'state:case_ancestor_hit', 'state:case_below_fold', 'state:case_scrolled_list']);
  expect(await handle.anchors({ 'action:case_visible': '#absent', 'state:case_plain': '#plain', 'state:case_covered': '[data-openlup-state="case_covered"]' }))
    .toEqual(['action:case_child_hit', 'state:case_ancestor_hit', 'state:case_below_fold', 'state:case_plain', 'state:case_scrolled_list']);
  expect(await page.evaluate(() => [window.scrollX, window.scrollY, document.getElementById('carousel')!.scrollTop, document.getElementById('list')!.scrollTop]),
    'every scroll position is restored').toEqual([0, 0, 0, 0]);
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
  expect(served).toMatchObject({ received: 1, answered: 1 });
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
  expect(served).toMatchObject({ received: 1, answered: 1 });
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
  expect(served).toMatchObject({ received: 1, answered: 1 });
});

test('page handle: settling refuses after its bound while an event stream stays open, naming the stream', async ({ page }) => {
  const handle = createPageHandle(page, { origin });
  const seen: string[] = [];
  const remove = await handle.intercept(request => { seen.push(`${request.method} ${request.path}`); return 'pass'; });
  await handle.navigate('/stream');
  await expect(page.locator('#stream')).toHaveText('open');
  expect(seen).toContain('GET /events');
  await expect(handle.settled({ quietMs: 100, timeoutMs: 1_500 })).rejects.toThrow(/^storefront_page_settle_timeout: 1 request did not finish within 1500 ms: GET \/events\. Cause: /);
  await remove();
});

test('page handle: settling follows a redirect and waits for the redirected request', async ({ page }) => {
  const handle = createPageHandle(page, { origin });
  await handle.navigate('/purchase');
  const remove = await handle.intercept(() => 'pass');
  await handle.perform({ attribute: 'action', value: 'redirect' }, { timeoutMs: 2_000 });
  await handle.settled({ quietMs: 100 });
  expect(served.landed).toBe(1);
  await expect(page.locator('#outcome')).toHaveText('landed');
  await remove();
});
