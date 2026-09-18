import type { VercelRequest, VercelResponse } from '../../server/_lib/types/vercel.js';
import { blobFacade } from '../../server/_lib/facades/blob.facade.js';
import { eventsLogger } from '../../server/_lib/facades/eventsLogger.facade.js';

export const config = { maxDuration: 60 };

const TTL_DAYS = 30;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const startedAt = Date.now();
  // Vercel Cron signs requests with Authorization: Bearer ${CRON_SECRET}.
  // Fail closed: refuse to run (and never delete blobs) when the secret is not
  // configured, matching the other cron handlers (e.g. subscription-renewal.ts).
  const expected = process.env.CRON_SECRET;
  if (!expected) {
    res.status(503).json({ ok: false, error: 'cron_secret_required' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${expected}`) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const cutoff = Date.now() - TTL_DAYS * 24 * 60 * 60 * 1000;
  const stats = { scanned: 0, deleted: 0, errors: 0 };

  try {
    const { blobs } = await blobFacade.listDetailed();
    stats.scanned = blobs.length;
    for (const b of blobs) {
      if (b.uploadedAt.getTime() < cutoff) {
        try {
          await blobFacade.delete(b.url);
          stats.deleted += 1;
        } catch (e) {
          stats.errors += 1;
          console.error('[cron/cleanup] delete failed', { url: b.url, error: String(e) });
        }
      }
    }
  } catch (e) {
    console.error('[cron/cleanup] list failed', e);
    res.status(500).json({ ok: false, error: 'list_failed', stats });
    await eventsLogger.record({
      eventType: 'cleanup_run',
      outcome: 'server_error',
      errorCode: 'LIST_FAILED',
      durationMs: Date.now() - startedAt,
      metadata: { ...stats, ttlDays: TTL_DAYS, error: String(e).slice(0, 200) },
    });
    return;
  }

  console.log('[cron/cleanup] done', stats);
  res.status(200).json({ ok: true, ttlDays: TTL_DAYS, ...stats });
  await eventsLogger.record({
    eventType: 'cleanup_run',
    outcome: stats.errors > 0 ? 'server_error' : 'success',
    errorCode: stats.errors > 0 ? 'DELETE_PARTIAL' : null,
    durationMs: Date.now() - startedAt,
    metadata: { ...stats, ttlDays: TTL_DAYS },
  });
}
