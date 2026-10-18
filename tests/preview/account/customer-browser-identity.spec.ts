import { loadEnv } from 'vite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';

// This credential-bearing acceptance journey must fail on missing setup, never self-skip.
test.use({ trace: 'off', screenshot: 'off', video: 'off', extraHTTPHeaders: {} });

test('captured email establishes persisted customer account and logout removes access', async ({ page, request, baseURL }) => {
  const env = loadEnv('test', '.', '');
  const origin = new URL(env.APP_BASE_URL ?? '');
  const auth = new URL(env.SUPABASE_URL ?? '');
  expect(baseURL).toBe(origin.origin);
  for (const url of [origin, auth]) {
    expect(url.protocol).toBe('http:');
    expect(['127.0.0.1', 'localhost', '[::1]']).toContain(url.hostname);
  }
  expect(env.OPENLUP_REFERENCE_PROFILE).toBe('subscription');
  expect(env.OPENLUP_REFERENCE_DISPOSABLE).toBe('1');
  const owned = env.OPENLUP_REFERENCE_SUPABASE_DIR;
  expect(owned).toBeTruthy();
  const marker = JSON.parse(readFileSync(join(owned!, 'subscription-owner.json'), 'utf8'));
  expect(marker.phase).toBe('sealed');
  expect(marker.projectId).toBe(env.OPENLUP_REFERENCE_PROJECT_ID);
  const config = readFileSync(join(owned!, 'supabase', 'config.toml'), 'utf8');
  const inbox = config.match(/^\[inbucket\]\s*\n([\s\S]*?)(?=^\[|$(?![\s\S]))/m)?.[1];
  expect(inbox).toMatch(/^enabled\s*=\s*true\s*$/m);
  const port = inbox?.match(/^port\s*=\s*(\d+)\s*$/m)?.[1];
  expect(port).toBeTruthy();
  const mail = `http://127.0.0.1:${port}`;
  // A unique synthetic recipient keeps this proof inside remaining per-address quota.
  const email = `browser-${Date.now()}@example.com`;
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { name: 'Sign in to your account' })).toBeVisible();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Request sign-in', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('does not confirm account existence or delivery');

  let messageId: string | undefined;
  await expect.poll(async () => {
    const response = await request.get(`${mail}/api/v1/messages`);
    expect(response.ok()).toBe(true);
    const list = await response.json() as { messages: Array<{ ID?: string; id?: string; To?: Array<string | { Address: string }>; to?: Array<string | { address: string }> }> };
    const message = list.messages.find((item) => [...(item.To ?? []), ...(item.to ?? [])].some((entry) => (typeof entry === 'string' ? entry : 'Address' in entry ? entry.Address : entry.address).toLowerCase() === email));
    messageId = message?.ID ?? message?.id;
    return Boolean(messageId);
  }, { timeout: 30_000, intervals: [1000] }).toBe(true);
  const detail = await request.get(`${mail}/api/v1/message/${encodeURIComponent(messageId!)}`);
  expect(detail.ok()).toBe(true);
  const message = await detail.json();
  const content = [message.HTML, message.Text, message.html, message.text].filter((value) => typeof value === 'string').join('\n').replaceAll('&amp;', '&').replaceAll('&#38;', '&');
  const link = (content.match(/https?:\/\/[^\s"'<>]+/g) ?? []).map((value) => new URL(value)).find((url) => url.origin === auth.origin && url.pathname === '/auth/v1/verify' && url.searchParams.has('token'));
  // Do not attach or print the message, callback URL or session to the report.
  expect(Boolean(link)).toBe(true);
  const me = page.waitForResponse((response) => new URL(response.url()).pathname === '/api/bff/customers/me' && response.status() === 200);
  try { await page.goto(link!.href); } catch { throw new Error('Captured confirmation navigation failed'); }
  await me;
  await expect.poll(() => new URL(page.url()).pathname).toBe('/account');
  expect(new URL(page.url()).origin).toBe(origin.origin);
  await expect(page.getByRole('heading', { name: 'Your recurring orders' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your recurring orders' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page).toHaveURL(`${origin.origin}/sign-in`);
  await expect(page.getByRole('heading', { name: 'Your recurring orders' })).toHaveCount(0);
  await page.goto('/account');
  await expect(page).toHaveURL(`${origin.origin}/sign-in`);
});
