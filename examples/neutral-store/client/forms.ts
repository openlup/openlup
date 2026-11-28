import type { Operation, ActionInput, ActionResult } from '../shared/api.ts';
import type { PageContext } from './context.ts';
import type { CopyKey } from '../owned/copy.ts';
import { storefrontAnchor } from '@openlup/platform/storefront';
import { act, uncertainAction } from './api.ts';
import { append, button, el, renderValue } from './dom.ts';
import { limitFor, nativeLimits, operationLimits, otherLimits } from '../shared/limits.ts';
import { sandboxOutcomeAttribute } from '../shared/storefront-bindings.ts';

export interface FieldSpec {
  name: string;
  label: CopyKey;
  type?: 'text' | 'password' | 'email' | 'tel' | 'number' | 'date' | 'textarea' | 'checkbox' | 'select';
  value?: string;
  required?: boolean;
  min?: number;
  max?: number;
  maxLength?: number;
  pattern?: string;
  options?: Array<{ value: string; text: string }>;
  autocomplete?: string;
  /** A `storefrontAnchor.field` value, rendered as `data-openlup-field` on the control. */
  anchor?: FieldAnchor;
}

/** A buyer-detail field anchor. */
export type FieldAnchor = (typeof storefrontAnchor.field)[keyof typeof storefrontAnchor.field];
/** A buyer action anchor. */
export type ActionAnchor = (typeof storefrontAnchor.action)[keyof typeof storefrontAnchor.action];

interface ActionFormBase {
  title?: CopyKey;
  submit: CopyKey | { label: string };
  fields?: FieldSpec[];
  input?: () => ActionInput;
  transform?: (values: ActionInput) => ActionInput;
  prepare?: (values: ActionInput) => Promise<ActionInput | null>;
  onRefusal?: (code: string) => void;
  onSuccess?: (value: unknown) => void;
  onFailure?: (code: string) => void;
  display?: (value: unknown) => unknown;
  resultMessage?: (value: unknown) => CopyKey | undefined;
  /** A `storefrontAnchor.action` value, rendered as `data-openlup-action` on the submit button. */
  submitAnchor?: ActionAnchor;
  /** A sandbox simulate button's outcome, rendered as `data-starter-sandbox-outcome` on the submit button. */
  sandboxOutcome?: 'captured' | 'refused' | 'expired' | 'indeterminate';
}

/**
 * The page sends the command itself, for example through a purchase-continuation controller, and owns its key.
 * `reviewed` is the JSON of the form's values without `locale`; `body` is what `prepare` returned. It resolves to
 * the answer the command applied, to the uncertain answer when none arrived, or to `null` when nothing was sent.
 */
export type FormSend = (input: { reviewed: string; body: ActionInput }) => Promise<ActionResult | null>;

/**
 * With `operation`, the form sends the action under a key it keeps, and a reset button starts a new one. With `send`,
 * the page sends it: the form keeps no key and renders no reset button, and `answerView` may supply the output to
 * show for each result instead of the default.
 */
export type ActionFormOptions = ActionFormBase & ({ operation: Operation; send?: undefined; answerView?: undefined } | {
  operation?: undefined;
  send: FormSend;
  /** Called only while the form's view is current; `null` shows nothing, `undefined` the default. */
  answerView?: (result: ActionResult | null) => HTMLElement | null | undefined;
});

let fieldCounter = 0;

export function field(context: PageContext, spec: FieldSpec): {
  wrapper: HTMLElement;
  control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
} {
  const id = `field-${++fieldCounter}`;
  const attrs = {
    id, name: spec.name, required: spec.required ?? true,
    maxlength: spec.maxLength ?? 200, autocomplete: spec.autocomplete ?? 'off',
  };
  let control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  if (spec.type === 'textarea') {
    control = el('textarea', { ...attrs, rows: 5, maxlength: spec.maxLength ?? 2000 }, spec.value ?? '');
  } else if (spec.type === 'select') {
    control = el('select', attrs, ...(spec.options ?? []).map(option =>
      el('option', { value: option.value, selected: spec.value === option.value }, option.text)));
  } else {
    control = el('input', { ...attrs, type: spec.type ?? 'text', value: spec.value ?? '',
      pattern: spec.pattern, min: spec.min, max: spec.max, step: spec.type === 'number' ? 1 : undefined });
  }
  if (spec.anchor) control.setAttribute(storefrontAnchor.attribute.field, spec.anchor);
  const wrapper = el('div', { class: spec.type === 'checkbox' ? 'field checkbox-field' : 'field' });
  const label = el('label', { for: id }, context.t(spec.label));
  if (spec.type === 'checkbox') append(wrapper, control, label);
  else append(wrapper, label, control);
  return { wrapper, control };
}

export function actionForm(context: PageContext, options: ActionFormOptions): HTMLElement {
  const form = el('form', { class: 'action-form' });
  const output = el('div', { class: 'action-result', role: 'status', 'aria-live': 'polite' });
  const controls: Array<{ spec: FieldSpec; control: ReturnType<typeof field>['control'] }> = [];
  if (options.title) append(form, el('h3', {}, context.t(options.title)));
  for (const spec of options.fields ?? []) {
    const item = field(context, spec);
    controls.push({ spec, control: item.control });
    append(form, item.wrapper);
  }
  const submit = el('button', { type: 'submit' }, typeof options.submit === 'string' ? context.t(options.submit) : options.submit.label);
  if (options.submitAnchor) submit.setAttribute(storefrontAnchor.attribute.action, options.submitAnchor);
  if (options.sandboxOutcome) submit.setAttribute(sandboxOutcomeAttribute, options.sandboxOutcome);
  // Keep command identity on an uncertain transport result. A changed input is a new command.
  let commandKey = crypto.randomUUID();
  let priorInput: string | null = null;
  let uncertain: { input: string; prepared: ActionInput } | undefined;
  let inFlight = false;
  let generation = 0;
  form.addEventListener('input', () => { ++generation; });
  form.addEventListener('change', () => { ++generation; });
  const send = options.send;
  const reset = send ? undefined : button(context.t('newAction'), () => {
    if (inFlight) return;
    ++generation;
    commandKey = crypto.randomUUID();
    priorInput = null;
    uncertain = undefined;
    output.replaceChildren();
  }, 'secondary');
  const busy = (value: boolean) => { inFlight = value; submit.disabled = value; if (reset) reset.disabled = value; };
  append(form, send ? null : el('p', { class: 'muted small' }, context.t('idempotency')),
    el('div', { class: 'actions' }, submit, reset), output);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (inFlight || submit.disabled || submit.getAttribute('aria-disabled') === 'true' || !form.isConnected || !form.reportValidity()) return;
    const requestGeneration = ++generation;
    const current = () => form.isConnected && generation === requestGeneration;
    void (async () => {
      let values: ActionInput = {};
      for (const { spec, control } of controls) {
        values[spec.name] = spec.type === 'checkbox'
          ? (control as HTMLInputElement).checked
          : spec.type === 'number' ? (control as HTMLInputElement).valueAsNumber : control.value.trim();
      }
      try {
        if (options.transform) values = options.transform(values);
        values = { ...values, ...options.input?.(), locale: context.locale };
      } catch {
        output.replaceChildren(refusal(context, 'starter_input_invalid'));
        return;
      }
      const input = JSON.stringify(values);
      const { locale: _locale, ...reviewed } = values;
      if (uncertain?.input === input) values = uncertain.prepared;
      else if (options.prepare) {
        busy(true);
        try {
          const prepared = await options.prepare(values);
          if (!current() || !prepared) return;
          values = prepared;
        } finally { busy(false); }
      }
      if (!current()) return;
      // A changed input is a new command. What prepare adds, such as a refreshed reviewed total, is not.
      if (!send && priorInput !== null && priorInput !== input) commandKey = crypto.randomUUID();
      priorInput = input;
      busy(true);
      form.setAttribute('aria-busy', 'true');
      output.replaceChildren(el('p', {}, context.t('loading')));
      try {
        const result = send ? await send({ reviewed: JSON.stringify(reviewed), body: values })
          : await act(options.operation, values, commandKey);
        if (result === null) {
          if (current()) output.replaceChildren(...[options.answerView?.(null) ?? []].flat());
          return;
        }
        uncertain = uncertainAction(result)
          ? { input, prepared: values } : undefined;
        // Every definite refusal of the command, or of its automatic repeat, runs the refusal hook.
        if (!result.ok && !uncertain) options.onRefusal?.(result.code);
        if (!current()) return;
        const custom = options.answerView?.(result);
        if (custom === null) { output.replaceChildren(); return; }
        const limit = options.operation === undefined ? undefined : operationLimits[options.operation];
        output.replaceChildren(custom ?? (result.ok
          ? el('section', {}, el('h4', {}, context.t('response')),
            options.resultMessage?.(result.value) ? el('p', {}, context.t(options.resultMessage(result.value)!)) : null,
            renderValue(options.display ? options.display(result.value) : result.value))
          : refusal(context, result.code, limit?.code === result.code ? limit.explanation[context.locale] : undefined)));
        if (!result.ok && result.issues?.length) append(output, renderValue(result.issues));
        if (result.ok) {
          for (const { spec, control } of controls) if (spec.type === 'password') control.value = '';
          options.onSuccess?.(result.value);
        } else options.onFailure?.(result.code);
      } finally {
        busy(false);
        form.removeAttribute('aria-busy');
      }
    })();
  });
  return form;
}

export function readPanel(context: PageContext, title: CopyKey, operation: Operation, input: ActionInput = {}): HTMLElement {
  const section = el('section', { class: 'panel' }, el('h2', {}, context.t(title)));
  const output = el('div', { role: 'status', 'aria-live': 'polite' });
  const reload = button(context.t('readStatus'), async () => {
    reload.disabled = true;
    output.replaceChildren(el('p', {}, context.t('loading')));
    const result = await act(operation, input, crypto.randomUUID());
    output.replaceChildren(result.ok ? renderValue(result.value) : refusal(context, result.code, operationLimits[operation]?.code === result.code ? operationLimits[operation]!.explanation[context.locale] : undefined));
    reload.disabled = false;
  }, 'secondary');
  append(section, reload, output);
  return section;
}

export function refusal(context: PageContext, code: string, explanation?: string): HTMLElement {
  return el('div', { class: 'refusal', role: 'status' },
    el('strong', {}, context.t('refusal')),
    el('code', {}, code),
    explanation ? el('p', {}, explanation) : null,
    el('p', { class: 'small' }, context.t('notSubmitted')));
}

export function refusedAction(context: PageContext, label: CopyKey, code?: string, explanation?: string): HTMLElement {
  const limit = limitFor(label);
  const reason = code ?? limit?.code ?? 'host_binding_required';
  const detail = explanation ?? limit?.explanation[context.locale];
  const output = el('div', { 'aria-live': 'polite' });
  return el('div', { class: 'refused-action' },
    button(context.t(label), () => { output.replaceChildren(refusal(context, reason, detail)); }, 'secondary'), output);
}

export function nativeActions(context: PageContext, ids: readonly string[]): HTMLElement {
  const container = el('section', { class: 'panel' }, el('h2', {}, context.t('limits')));
  for (const id of ids) {
    const limit = nativeLimits.find(item => item.id === id);
    if (!limit) continue;
    append(container, el('p', { class: 'small' }, limit.explanation[context.locale]),
      ...limit.actions.map(action => refusedAction(context, action)));
  }
  return container;
}

export function otherRefusal(context: PageContext, key: keyof typeof otherLimits): HTMLElement {
  return refusedAction(context, key, otherLimits[key]);
}
