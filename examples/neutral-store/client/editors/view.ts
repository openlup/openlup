import type { PackageEditMoney } from '@openlup/platform/subscriptions/contracts';
import type { PageContext } from '../context.ts';
import { act } from '../api.ts';
import { el, button } from '../dom.ts';
import { isRecord } from '../../shared/offer.ts';
import type { EditorSubscription } from '../../shared/subscription-edit.ts';
import { editorText, type EditorCopyKey } from '../../owned/editor-copy.ts';

export const key = (scope: string) => `${scope}-${crypto.randomUUID()}`;
export class EditorFailure extends Error {}
export async function editorAction(operation: Parameters<typeof act>[0],input: Record<string,unknown>,identity = key('editor')): Promise<unknown> {
  const result = await act(operation,input,identity);
  if (!result.ok) throw new EditorFailure(result.code);
  return result.value;
}
export async function editorAccount(): Promise<EditorSubscription[]> {
  const result = await editorAction('account.read',{});
  if (!isRecord(result) || !Array.isArray(result.subscriptionEditors)) throw new EditorFailure('starter_account_projection_binding_required');
  return result.subscriptionEditors as EditorSubscription[];
}
export function text(context: PageContext,key: EditorCopyKey,values?: Record<string,string | number>): string {
  return editorText(context.locale,key,values);
}
export function notice(context: PageContext,code: string): string {
  const keys: Record<string,EditorCopyKey> = { payment_blocked: 'paymentBlocked',cycle_locked: 'cycleLocked',not_active: 'notActive',
    missing_payment_method: 'methodMissing',edit_window_closed: 'windowClosed',starter_subscription_template_unavailable: 'templateMissing',
    subscription_edit_window_closed: 'windowClosed',subscription_command_payment_blocked: 'paymentBlocked',subscription_lifecycle_payment_blocked: 'paymentBlocked',
    subscription_command_cycle_locked: 'cycleLocked',subscription_edit_invalid_intro_fixed: 'fixed',
    subscription_reprice_below_minimum_order_units: 'belowMinimum',subscription_reprice_sized_below_minimum: 'belowMinimum',
    subscription_reprice_sized_stock_unavailable: 'stock',subscription_reprice_sized_exclusion_conflict: 'exclusion',
    subscription_reprice_sized_need_unreadable: 'needUnavailable',subscription_reprice_sized_subject_facts_unreadable: 'needUnavailable',
    starter_subscription_resize_unconfigured: 'configuredLimit' };
  return text(context,keys[code] ?? 'unavailable');
}
export function control(label: string,run: () => void | Promise<void>,disabled = false): HTMLButtonElement {
  const node = button(label,run); node.disabled = disabled; return node;
}
export function date(context: PageContext,value: string | null): string {
  return value && Number.isFinite(Date.parse(value)) ? new Intl.DateTimeFormat(context.locale,{ timeZone: context.config.market.timezone,dateStyle: 'long' }).format(new Date(value)) : '—';
}
export function quoteRows(context: PageContext,current: PackageEditMoney,next: PackageEditMoney,delta: PackageEditMoney): HTMLElement {
  const money = (value: PackageEditMoney,signed = false) => new Intl.NumberFormat(context.locale,{ style: 'currency',currency: value.currency,
    ...(signed ? { signDisplay: 'always' as const } : {}) }).format(value.amountMinor/100);
  return el('dl',{ class: 'response-fields','data-testid': 'price-review' },
    el('dt',{},text(context,'currentPrice')),el('dd',{},money(current)),
    el('dt',{},text(context,'newPrice')),el('dd',{},money(next)),
    el('dt',{},text(context,'delta')),el('dd',{ class: delta.amountMinor > 0 ? 'price-increase' : delta.amountMinor < 0 ? 'price-decrease' : '' },money(delta,true)));
}
/** Keep keyboard focus when a selected variant changes and the row is redrawn. */
export function replaceEditor(root: HTMLElement,child: HTMLElement): void {
  const active = root.contains(document.activeElement) ? document.activeElement?.getAttribute('data-focus') : null;
  root.replaceChildren(child);
  if (active) [...root.querySelectorAll<HTMLElement>('[data-focus]')].find(element => element.getAttribute('data-focus') === active)?.focus();
}
