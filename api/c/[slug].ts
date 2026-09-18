import type { VercelRequest, VercelResponse } from '../../server/_lib/types/vercel.js';
import { blobFacade } from '../../server/_lib/facades/blob.facade.js';
import { applyAppShellAssetOverrides } from '../../src/lib/brand/appShellAssets.js';

export const config = { maxDuration: 10 };

const SLUG_RE = /^[a-z0-9]{6,32}$/;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const slug = singleParam(req.query.slug);

  if (!slug || !SLUG_RE.test(slug)) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(400).send(renderNotFound('Niepoprawny adres puszki.'));
    return;
  }

  // O(1) lookup — construct URL deterministically from slug, verify via HEAD against
  // Vercel Blob CDN. Avoids list() which is O(N) over the entire store on every hit.
  const imageUrl = blobFacade.urlFor(slug);
  const exists = await blobFacade.exists(slug).catch((e) => {
    console.error('[share] head check failed', e);
    return false;
  });
  if (!exists) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(404).send(renderNotFound('Ta puszka wygasła lub nie istnieje.'));
    return;
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=300');
  res.status(200).send(renderShare(slug, imageUrl));
}

function singleParam(v: string | string[] | undefined): string | null {
  if (Array.isArray(v)) return v[0] ?? null;
  return typeof v === 'string' ? v : null;
}

const TITLE = 'Mój pies na puszce OPENLUP 🐶';
const DESC = 'Zobacz mojego psa na puszce OPENLUP. Stwórz własną w 60 sekund.';
const SITE_URL = 'https://openlup.com';

// This handler composes its own entry document, so it carries the same obligation
// `index.html` carries: every static path it names must be answerable by a tree
// that contains only publishable files. It therefore names the neutral shell under
// `public/platform/` and puts this deployment's own files back through
// `applyAppShellAssetOverrides` — the F4 mechanism, applied to a document a
// serverless function writes rather than to the one the bundler transforms. The
// bytes this deployment serves are unchanged: `/platform/favicon.svg` is a key of
// `APP_SHELL_ASSET_OVERRIDES` and resolves to `/favicon.svg`.
function renderShare(slug: string, imageUrl: string): string {
  const shareUrl = `${SITE_URL}/c/${slug}`;
  return applyAppShellAssetOverrides(`<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${TITLE}</title>
<meta name="description" content="${DESC}">
<link rel="canonical" href="${shareUrl}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="openlup">
<meta property="og:title" content="${TITLE}">
<meta property="og:description" content="${DESC}">
<meta property="og:url" content="${shareUrl}">
<meta property="og:image" content="${imageUrl}">
<meta property="og:image:width" content="1024">
<meta property="og:image:height" content="1536">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${TITLE}">
<meta name="twitter:description" content="${DESC}">
<meta name="twitter:image" content="${imageUrl}">
<link rel="icon" type="image/svg+xml" href="/platform/favicon.svg">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  body { margin:0; font-family:'Plus Jakarta Sans',system-ui,sans-serif; background:#fff; color:#1f1f1f; }
  .wrap { max-width:780px; margin:0 auto; padding:40px 20px; text-align:center; }
  .can { max-width:100%; max-height:75vh; border-radius:18px; }
  h1 { font-size:2rem; font-weight:800; margin:24px 0 8px; }
  p.lede { color:#666; font-size:1.05rem; margin:0 0 24px; }
  a.cta {
    display:inline-block; padding:14px 28px; background:#111; color:#fff;
    border-radius:9999px; text-decoration:none; font-weight:700; font-size:1rem;
  }
  a.cta:hover { background:#333; }
  .brand { font-weight:800; font-size:1.4rem; letter-spacing:-0.02em; }
  footer { color:#999; font-size:0.85rem; margin-top:60px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="brand">openlup</div>
  <img src="${imageUrl}" alt="Puszka OPENLUP z psem" class="can" loading="eager">
  <h1>Mój pies na puszce OPENLUP 🐶</h1>
  <p class="lede">Stwórz puszkę swojego psa — w 60 sekund, bezpłatnie.</p>
  <a class="cta" href="${SITE_URL}/zrob-puszke">✨ Stwórz swoją puszkę</a>
  <footer>${SITE_URL}</footer>
</div>
</body>
</html>`);
}

function renderNotFound(message: string): string {
  return `<!doctype html>
<html lang="pl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>Puszka nie znaleziona — openlup</title>
<style>
  body { margin:0; font-family:system-ui,sans-serif; background:#fff; color:#1f1f1f;
    display:flex; align-items:center; justify-content:center; min-height:100vh; }
  .wrap { max-width:480px; padding:40px 20px; text-align:center; }
  h1 { font-size:1.5rem; margin:0 0 8px; }
  a { display:inline-block; margin-top:20px; padding:12px 24px; background:#111;
    color:#fff; border-radius:9999px; text-decoration:none; font-weight:700; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${message}</h1>
  <p>Puszki są zachowywane przez 30 dni od wygenerowania.</p>
  <a href="${SITE_URL}/zrob-puszke">Stwórz nową puszkę</a>
</div>
</body>
</html>`;
}
