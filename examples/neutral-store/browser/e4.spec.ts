import { test as base, expect, type Locator } from '@playwright/test';
import { readFileSync, existsSync } from 'node:fs';
import { copy } from '../owned/copy.ts';
import { routes } from '../shared/routes.ts';
import type { Operation } from '../shared/api.ts';
import { operationLimits, operationLimitDefinitions } from '../shared/limits.ts';

interface DocumentFixture {
  mailbox: string;
  customerEmail: string;
  operatorEmail: string;
  orderRef: string;
  documentRef: string;
  orderItemId: string;
  shipmentRef: string;
}
const test = base.extend<{ fixturePath: string }>({ fixturePath: ['', { option: true }] });

test('localized order controls and owned PDF in both languages', async ({ page, context, baseURL, fixturePath }) => {
  // Real installed host, mailbox and PostgreSQL are supplied by the proof runner.
  test.setTimeout(120000);
  if (!baseURL || !fixturePath) throw new Error('starter_document_browser_fixture_required');
  const fixture: DocumentFixture = JSON.parse(readFileSync(fixturePath, 'utf8'));
  const action = async (operation: string, data: Record<string, unknown>) => {
    const response = await page.request.post(`${baseURL}/api/actions/${operation}`, {
      headers: { Origin: baseURL, 'X-Starter-Request': '1', 'Idempotency-Key': crypto.randomUUID() }, data,
    });
    return response.json();
  };
  const signIn = async (operator: boolean) => {
    const email = operator ? fixture.operatorEmail : fixture.customerEmail;
    const messages = () => existsSync(fixture.mailbox) ? readFileSync(fixture.mailbox, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    const priorCount = messages().length;
    expect((await action(operator ? 'auth.operator' : 'auth.request', { email })).ok).toBe(true);
    let token = '';
    await expect.poll(() => {
      token = messages().slice(priorCount).filter(message => message.email === email).at(-1)?.token ?? '';
      return token;
    }).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect((await action(operator ? 'auth.operator' : 'auth.verify', { token })).ok).toBe(true);
  };
  // Customer and operator challenges each allow one issue per minute. Keep
  // that real boundary after the HTTP fixture and between configurations.
  await new Promise(resolve => setTimeout(resolve, 61000));
  await signIn(false);
  const customerCookies = await context.cookies();
  await context.clearCookies();
  await signIn(true);
  const operatorCookies = await context.cookies();
  for (const locale of ['en', 'pl'] as const) {
    const submitRefused = async (form: Locator, operation: Operation, fields: Readonly<Record<string, string | boolean>>) => {
      for (const [name, value] of Object.entries(fields)) {
        if (typeof value === 'boolean') await form.locator(`[name=${name}]`).setChecked(value);
        else await form.locator(`[name=${name}]`).fill(value);
      }
      await form.locator('button[type=submit]').click();
      const limit = operationLimits[operation]!;
      await expect(form.locator('.action-result')).toContainText(limit.code);
      await expect(form.locator('.action-result')).toContainText(limit.explanation[locale]);
    };
    await context.clearCookies();
    await context.addCookies(customerCookies);
    await page.goto(routes.tracking[locale]);
    await submitRefused(page.locator('main form'), 'tracking.read', { shipmentRef: fixture.orderRef });
    await page.goto(routes.research[locale]);
    await submitRefused(page.locator('main form'), 'research.submit', { caseReference: fixture.orderRef, feedback: 'Example response' });
    await page.goto(routes.invoices[locale]);
    const downloadForm = page.locator('form').filter({ has: page.locator('[name=documentRef]') });
    await downloadForm.locator('[name=orderRef]').fill(fixture.orderRef.toUpperCase());
    await downloadForm.locator('[name=documentRef]').fill(fixture.documentRef.toUpperCase());
    const downloadEvent = page.waitForEvent('download');
    await downloadForm.getByRole('button', { name: copy[locale].download, exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toMatch(/\.pdf$/);
    const path = await download.path();
    if (!path) throw new Error('starter_document_download_missing');
    const bytes = readFileSync(path);
    expect(bytes.subarray(0, 5).toString()).toBe('%PDF-');
    expect(bytes.toString().includes('NON-FISCAL TEST DOCUMENT')).toBe(true);
    await expect(downloadForm.locator('.action-result')).toContainText('application/pdf');
    await expect(downloadForm.locator('.action-result')).not.toContainText('base64');
    await context.clearCookies();
    await context.addCookies(operatorCookies);
    await page.goto(routes.admin[locale]);
    const returns = page.locator('#returns');
    await expect(returns.locator('section.panel')).toHaveCount(0);
    await expect(returns.locator('[name=returnRef]')).toHaveCount(2);
    const hold = page.locator('#orders form').filter({ has: page.getByRole('button', { name: copy[locale].hold, exact: true }) });
    await expect(hold.locator('[name=reason]')).toHaveJSProperty('tagName', 'SELECT');
    await hold.locator('[name=orderRef]').fill(fixture.orderRef.toUpperCase());
    await hold.locator('[name=note]').fill('Example hold');
    const response = page.waitForResponse(response => response.url().endsWith('/api/actions/operator.hold'));
    await hold.getByRole('button', { name: copy[locale].hold, exact: true }).click();
    const held = await (await response).json(); expect(held.ok).toBe(true);
    await expect(hold.locator('.action-result')).toContainText('active');
    const release = page.locator('#orders form').filter({ has: page.getByRole('button', { name: copy[locale].releaseHold, exact: true }) });
    await release.locator('[name=holdRef]').fill(held.value.hold.id.toUpperCase());
    await release.locator('[name=note]').fill('Example release');
    await release.getByRole('button', { name: copy[locale].releaseHold, exact: true }).click();
    await expect(release.locator('.action-result')).toContainText('released');
    await submitRefused(page.locator('#ingest form'), 'ingest.submit', { order: '{}' });
    const shipments = page.locator('#shipments');
    const label = shipments.locator('form').filter({ has: page.getByRole('button', { name: copy[locale].label, exact: true }) });
    await label.locator('[name=shipmentRef]').fill(fixture.orderRef);
    await label.locator('[name=labelRef]').fill('synthetic-label');
    await label.getByRole('button', { name: copy[locale].label, exact: true }).click();
    const shipment = operationLimits['operator.label']!;
    await expect(label.locator('.action-result')).toContainText(shipment.code);
    await expect(label.locator('.action-result')).toContainText(shipment.explanation[locale]);
    for (const [operation, label] of [['operator.handoff', 'handoff'], ['operator.delivery', 'delivery']] as const) {
      await submitRefused(shipments.locator('form').filter({ has: page.getByRole('button', { name: copy[locale][label], exact: true }) }),
        operation, { shipmentRef: fixture.orderRef, evidenceRef: 'synthetic-evidence' });
    }
    const list = shipments.locator('section.panel');
    await list.getByRole('button', { name: copy[locale].readStatus, exact: true }).click();
    await expect(list.locator('[role=status]')).toContainText(fixture.shipmentRef);
    await expect(list.locator('[role=status]')).toContainText('commerce.fulfillment.v0');
    const detail = shipments.locator('form').filter({ has: page.getByRole('button', { name: copy[locale].read, exact: true }) });
    await detail.locator('[name=shipmentRef]').fill(fixture.shipmentRef.toUpperCase());
    await detail.getByRole('button', { name: copy[locale].read, exact: true }).click();
    await expect(detail.locator('.action-result')).toContainText(fixture.shipmentRef);
    await expect(detail.locator('.action-result')).toContainText('Pinned example street');
    await page.goto(routes.limits[locale]);
    for (const limit of Object.values(operationLimitDefinitions)) {
      const row = page.locator('tr').filter({ hasText: limit.explanation[locale] });
      await expect(row).toContainText(limit.code);
      await expect(row).toContainText(limit.explanation[locale]);
    }
  }
});
