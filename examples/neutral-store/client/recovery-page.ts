import type { PageContext } from './context.ts';
import { routes } from '../shared/routes.ts';
import { demoRecoveryConfiguration, type RecoveryState } from '../shared/recovery-config.ts';
import { isRecord } from '../shared/offer.ts';
import { el, link, button } from './dom.ts';
import { nativeActions } from './forms.ts';
import { act } from './api.ts';
import { currentRecoveryToken } from './recovery-session.ts';

export function authenticatedRepairPage(context: PageContext): HTMLElement {
  const copy = context.config.recovery ?? demoRecoveryConfiguration;
  const state = el('section', { class: 'panel', 'aria-live': 'polite' }, el('p', {}, context.t('loading')));
  const page = el('div', {}, el('h1', {}, context.t('repair')), state,
    el('p', {}, copy.states.support[context.locale]),
    link(context.t('support'), routes.support[context.locale]),
    el('p', { class: 'notice' }, context.t('subscriptionInvariant')), nativeActions(context, ['N6']));
  const request = async (action: 'read' | 'authorize') => {
    const token = currentRecoveryToken();
    if (!token) { render('unavailable'); return; }
    const result = await act('payment.recover', { token, action, locale: context.locale }, crypto.randomUUID());
    if (!page.isConnected) return;
    if (!result.ok) { render(result.code === 'customer_session_required' ? 'login_required' : 'unavailable'); return; }
    const value = isRecord(result.value) ? result.value.state : null;
    render(typeof value === 'string' && Object.hasOwn(copy.states, value) ? value as RecoveryState : 'unavailable');
  };
  const render = (value: RecoveryState) => {
    state.replaceChildren(el('p', {}, copy.states[value][context.locale]));
    if (value === 'login_required') {
      state.append(link(context.t('signIn'), routes.auth[context.locale]));
      state.append(button(context.t('continue'), () => { void request('read'); }));
    }
    if (value === 'awaiting_confirmation' || value === 'exhausted') {
      state.append(button(context.t('repairAction'), () => { void request('authorize'); }));
    }
    if (value === 'authorized_retry' || value === 'awaiting_confirmation') {
      state.append(button(context.t('continue'), () => { void request('read'); }));
    }
  };
  void request('read');
  return page;
}
