import { test, expect } from '@playwright/test';
import { routes } from '../shared/routes.ts';
import { editorComponent, fixtureId } from './editor-component-fixtures.ts';

const classic = `${routes.classicEdit.en}?subscription=${fixtureId(90)}`;
const sized = `${routes.sizedEdit.en}?subscription=${fixtureId(90)}`;
const line = (n: number) => `[data-testid="editor-line-${fixtureId(n)}"]`;
const group = (n: number) => `[data-testid="editor-group-${fixtureId(n+100)}"]`;
test('classic keeps independent counts, removes explicitly, adds one unit and distributes the remainder',async ({ page }) => {
  await editorComponent(page); await page.goto(classic);
  await expect(page.locator(line(3)).getByRole('button',{ name: 'Remove one unit: Item 3',exact: true })).toBeDisabled();
  await page.getByRole('button',{ name: 'Remove Item 3 from package',exact: true }).click();
  await expect(page.locator(line(3))).toHaveCount(0);
  await expect(page.locator(line(1)).locator('output')).toHaveText('8');
  await page.getByRole('button',{ name: 'Add Item 4 to package',exact: true }).click();
  await expect(page.locator(line(4)).locator('output')).toHaveText('1');
  await page.getByRole('button',{ name: 'Distribute evenly',exact: true }).click();
  await expect(page.locator(line(1)).locator('output')).toHaveText('5');
  await expect(page.locator(line(2)).locator('output')).toHaveText('5');
  await expect(page.locator(line(4)).locator('output')).toHaveText('4');
});
test('classic minimum and last-line removal answer in words and keep the line',async ({ page }) => {
  const state = await editorComponent(page); state.sub.lines = state.sub.lines.filter(item => !item.isAddon).map((item,index) => ({ ...item,qty: [3,2,1][index]! }));
  await page.goto(classic);
  const remove = page.getByRole('button',{ name: 'Remove Item 3 from package',exact: true });
  await expect(remove).toHaveAttribute('aria-disabled','true');
  // Exercise the explanatory refusal handler, like the component's direct click witness.
  await remove.dispatchEvent('click');
  await expect(page.locator(line(3)).getByRole('alert')).toContainText('minimum is 6');
  state.sub.lines = [{ ...state.sub.lines[0]!,qty: 8 }]; await page.reload();
  await page.getByRole('button',{ name: 'Remove Item 1 from package',exact: true }).dispatchEvent('click');
  await expect(page.locator(line(1)).getByRole('alert')).toHaveText('At least one base product must remain.');
});
test('classic explicit review shows server money, signed delta and account cycle; confirmation refreshes account',async ({ page }) => {
  const state = await editorComponent(page); await page.goto(classic);
  await page.getByRole('button',{ name: 'Every 14 days',exact: true }).click();
  expect(state.requests.some(item => item.operation === 'subscription.preview')).toBe(false);
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  await expect(page.getByTestId('price-review')).toContainText('150.00');
  await expect(page.getByTestId('price-review')).toContainText('+');
  await expect(page.locator('main')).toContainText('November 20, 2030');
  await expect(page.locator('main')).not.toContainText('December 1, 2030');
  await expect(page.locator('main')).toContainText('without the one-time introductory promotion');
  await page.getByRole('button',{ name: 'Confirm changes',exact: true }).click();
  await expect(page).toHaveURL(/\/account\?packageSaved=1$/);
  const preview = state.requests.find(item => item.operation === 'subscription.preview')!,apply = state.requests.find(item => item.operation === 'subscription.command')!;
  expect(apply.key).not.toBe(preview.key);
  expect(apply.payload.request).toEqual({ ...(preview.payload.request as object),acceptedQuoteHash: 'a'.repeat(64) });
  expect(state.requests.filter(item => item.operation === 'account.read').length).toBeGreaterThan(1);
});
test('classic plan changes preserve quantities; only agreed extras can be removed and restored at saved quantity',async ({ page }) => {
  const state = await editorComponent(page); await page.goto(classic);
  await page.getByRole('button',{ name: 'Remove Item 8 (2)',exact: true }).click();
  await page.getByRole('button',{ name: 'Restore Item 8 (2)',exact: true }).click();
  await page.getByRole('button',{ name: 'Every 14 days',exact: true }).click();
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  const request = state.requests.find(item => item.operation === 'subscription.preview')!.payload.request as { base: unknown; addons: unknown };
  expect(request.base).toEqual([{ variantId: fixtureId(1),qty: 8 },{ variantId: fixtureId(2),qty: 5 },{ variantId: fixtureId(3),qty: 1 }]);
  expect(request.addons).toEqual([{ variantId: fixtureId(8),qty: 2 }]);
  await page.getByRole('button',{ name: 'Back to account',exact: true }).click();
  await page.goto(classic); await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeDisabled();
});
test('classic stale acceptance returns to editing, and a fresh review can be made',async ({ page }) => {
  const state = await editorComponent(page); state.applyFails = true; await page.goto(classic);
  await page.getByRole('button',{ name: 'Every 14 days',exact: true }).click();
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  await page.getByRole('button',{ name: 'Confirm changes',exact: true }).click();
  await expect(page.getByTestId('editor-error')).toContainText('could not be saved');
  await expect(page.getByRole('button',{ name: 'Confirm changes',exact: true })).toHaveCount(0);
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Confirm changes',exact: true })).toBeEnabled();
});
test('classic below-minimum baseline and failed catalogue disable review',async ({ page }) => {
  const state = await editorComponent(page); state.sub.lines = [{ ...state.sub.lines[0]!,qty: 1 }];
  await page.goto(classic); await expect(page.getByTestId('minimum-banner')).toBeVisible();
  await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeDisabled();
  state.catalogFails = true; await page.reload();
  await expect(page.getByRole('alert').filter({ hasText: 'catalogue is unavailable' })).toBeVisible();
  await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeDisabled();
});
for (const [reason,message] of [['edit_window_closed','edit window'],['payment_blocked','open payment case'],['cycle_locked','already being processed']] as const) {
  test(`classic ${reason} is a specific non-editable notice`,async ({ page }) => {
    const state = await editorComponent(page); state.sub.canEditUpcomingPackage = false; state.sub.editBlockedReason = reason;
    await page.goto(classic); await expect(page.getByRole('alert')).toContainText(message);
    await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toHaveCount(0);
  });
}
test('classic pending preview holds base controls while preserving the original plan/add-on control placement',async ({ page }) => {
  const state = await editorComponent(page); let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  state.previewReply = async route => { await pending; await route.fulfill({ contentType: 'application/json',body: JSON.stringify({ ok: true,value: state.preview }) }); };
  await page.goto(classic); await page.getByRole('button',{ name: 'Every 14 days',exact: true }).click();
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Add one unit: Item 1',exact: true })).toBeDisabled();
  await expect(page.getByRole('button',{ name: 'Every 28 days',exact: true })).toBeEnabled();
  await expect(page.getByRole('button',{ name: 'Remove Item 8 (2)',exact: true })).toBeEnabled();
  release(); await expect(page.getByRole('button',{ name: 'Confirm changes',exact: true })).toBeEnabled();
});
test('classic failed success-readback keeps the editor open',async ({ page }) => {
  const state = await editorComponent(page); await page.goto(classic);
  await page.getByRole('button',{ name: 'Every 14 days',exact: true }).click();
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click(); state.readbackFails = true;
  await page.getByRole('button',{ name: 'Confirm changes',exact: true }).click();
  await expect(page.getByTestId('editor-error')).toContainText('could not be saved'); await expect(page).toHaveURL(/edit-package/);
});
test('opt-in entry and back preserve classic; unchanged contents require review and explicit consent',async ({ page }) => {
  const state = await editorComponent(page,{ optIn: true }); await page.goto(sized+'&optIn=1');
  await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeEnabled();
  expect(state.requests.some(item => item.operation === 'subscription.command')).toBe(false);
  await page.getByRole('button',{ name: 'Back to classic package',exact: true }).click();
  await expect(page).toHaveURL(/edit-package/); expect(state.sub.offerVersion).toBe('classic');
  await page.goto(sized+'&optIn=1'); await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  await expect(page.getByTestId('opt-in-consent')).toContainText('from classic to size-aware');
  await page.getByRole('button',{ name: 'I accept size-aware servicing and the price; save',exact: true }).click();
  await expect(page).toHaveURL(/packageSaved=1/);
  const preview = state.requests.find(item => item.operation === 'subscription.preview')!,apply = state.requests.find(item => item.operation === 'subscription.command')!;
  expect(apply.key).toBe(preview.key); expect(apply.payload.request).toEqual({ ...(preview.payload.request as object),acceptedQuoteHash: 'a'.repeat(64) });
  expect((preview.payload.request as { resizeLever: { value: { optInToSized: boolean } } }).resizeLever.value.optInToSized).toBe(true);
});
test('sized exact size keeps count and keyboard focus; count/group/cadence changes and coverage remain explicit',async ({ page }) => {
  const state = await editorComponent(page,{ sized: true }); await page.goto(sized);
  const select = page.getByRole('combobox',{ name: 'Size: Item 1',exact: true }); await select.focus(); await select.selectOption(fixtureId(5));
  await expect(page.getByRole('combobox',{ name: 'Size: Item 1',exact: true })).toBeFocused();
  await expect(page.locator(group(1)).locator('output')).toHaveText('8');
  await page.getByRole('button',{ name: 'Add one unit: Item 2',exact: true }).click();
  await page.getByRole('button',{ name: 'Add Item 4 to package',exact: true }).click();
  await page.getByRole('button',{ name: 'Every 14 days',exact: true }).click();
  await expect(page.getByTestId('coverage-summary')).toContainText('16 base units');
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  await expect(page.locator('main')).toContainText('December 1, 2030');
  expect((state.requests.find(item => item.operation === 'subscription.preview')!.payload.request as { resizeLever: { value: { coreLines: unknown } } }).resizeLever.value.coreLines)
    .toEqual([{ variantId: fixtureId(5),qty: 8 },{ variantId: fixtureId(2),qty: 6 },{ variantId: fixtureId(3),qty: 1 },{ variantId: fixtureId(4),qty: 1 }]);
});
test('sized zero stock retains/reduces an agreement and insufficient destination stock disables its size choice',async ({ page }) => {
  const state = await editorComponent(page,{ sized: true }); state.catalog[0]!.sellableNow = 0; state.catalog[4]!.sellableNow = 7;
  await page.goto(sized); await expect(page.locator(group(1)).locator('output')).toHaveText('8');
  await expect(page.getByRole('button',{ name: 'Add one unit: Item 1',exact: true })).toBeDisabled();
  await expect(page.getByRole('combobox',{ name: 'Size: Item 1',exact: true }).locator(`option[value="${fixtureId(5)}"]`)).toBeDisabled();
  await page.getByRole('button',{ name: 'Remove one unit: Item 1',exact: true }).click();
  await expect(page.locator(group(1)).locator('output')).toHaveText('7');
  await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeEnabled();
});
test('sized conflicting selections can be repaired before preview, with other counts retained',async ({ page }) => {
  const state = await editorComponent(page,{ sized: true }); state.catalog[1]!.selectable = false; state.catalog[2]!.selectable = false;
  await page.goto(sized); await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeDisabled();
  await page.getByRole('button',{ name: 'Remove Item 2 from package',exact: true }).click();
  await page.getByRole('button',{ name: 'Remove Item 3 from package',exact: true }).click();
  await expect(page.locator(group(1)).locator('output')).toHaveText('8');
  await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeEnabled();
});
test('sized catalogue refresh invalidates review and preserves the exact omitted size and counts',async ({ page }) => {
  const state = await editorComponent(page,{ sized: true }); await page.goto(sized);
  await page.getByRole('button',{ name: 'Add one unit: Item 1',exact: true }).click();
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Confirm changes',exact: true })).toBeVisible();
  state.catalog = state.catalog.filter(item => item.variantId !== fixtureId(1));
  await page.getByRole('button',{ name: 'Refresh catalogue',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Confirm changes',exact: true })).toHaveCount(0);
  await expect(page.locator(group(1))).toContainText('9 × 250 g');
});
test('sized uncertain save requires account readback before another preview',async ({ page }) => {
  const state = await editorComponent(page,{ sized: true }); state.applyFails = true; await page.goto(sized);
  await page.getByRole('button',{ name: 'Add one unit: Item 1',exact: true }).click();
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click(); state.readbackFails = true;
  await page.getByRole('button',{ name: 'Confirm changes',exact: true }).click();
  await expect(page.getByTestId('editor-error')).toContainText('save is unconfirmed');
  await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toBeDisabled();
  state.readbackFails = false; await page.getByRole('button',{ name: 'Read account again',exact: true }).click();
  await expect(page.getByRole('button',{ name: 'Read account again',exact: true })).toHaveCount(0);
  await expect(page.locator(group(1)).locator('output')).toHaveText('8');
});
test('sized stale preview version refreshes account and cannot be confirmed',async ({ page }) => {
  const state = await editorComponent(page,{ sized: true }); state.preview.preview.templateVersion = 4;
  await page.goto(sized); await page.getByRole('button',{ name: 'Add one unit: Item 1',exact: true }).click();
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  await expect.poll(() => state.requests.filter(item => item.operation === 'account.read').length).toBeGreaterThan(1);
  await expect(page.getByRole('button',{ name: 'Confirm changes',exact: true })).toHaveCount(0);
});
test('sized fixed introductory contents are read-only, and missing need fails closed',async ({ page }) => {
  const state = await editorComponent(page,{ sized: true }); state.paidCycleCount = 1;
  state.marker = { basisTemplateVersion: 3,graduation: { cadenceDays: 28,lines: [] } };
  await page.goto(sized); await expect(page.getByRole('alert')).toContainText('fixed during the introductory phase');
  await expect(page.getByRole('button',{ name: 'Review changes',exact: true })).toHaveCount(0);
  state.marker = null; state.sub.compositionConstraint = { kind: 'unit_count',value: 14,dailyNeed: 0 }; await page.reload();
  await expect(page.getByRole('alert')).toContainText('subject facts cannot be read');
});
test('sized incomplete server quote cannot authorize confirmation',async ({ page }) => {
  const state = await editorComponent(page,{ sized: true }); state.preview.quoteHash = '';
  await page.goto(sized); await page.getByRole('button',{ name: 'Add one unit: Item 1',exact: true }).click();
  await page.getByRole('button',{ name: 'Review changes',exact: true }).click();
  await expect(page.getByRole('alert')).toBeVisible(); await expect(page.getByRole('button',{ name: 'Confirm changes',exact: true })).toHaveCount(0);
});
test('both editor routes render localized controls and notices',async ({ page }) => {
  await editorComponent(page); await page.goto(`${routes.classicEdit.pl}?subscription=${fixtureId(90)}`);
  await expect(page.getByRole('heading',{ level: 1 })).toHaveText('Edytuj pakiet');
  await expect(page.getByRole('button',{ name: 'Podejrzyj zmiany',exact: true })).toBeVisible();
  await page.goto(`${routes.sizedEdit.pl}?subscription=${fixtureId(90)}&optIn=1`);
  await expect(page.getByRole('heading',{ level: 1 })).toHaveText('Edytuj rozmiary i ilości');
  await expect(page.getByRole('button',{ name: 'Wróć do pakietu klasycznego',exact: true })).toBeVisible();
});
