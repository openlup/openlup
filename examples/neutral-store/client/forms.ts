import type { Operation, ActionInput } from '../shared/api.ts';
import type { PageContext } from './context.ts';
import type { CopyKey } from '../owned/copy.ts';
import { act } from './api.ts';
import { append, button, el, renderValue } from './dom.ts';
import { limitFor, nativeLimits, operationLimits, otherLimits } from '../shared/limits.ts';

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
}

export interface ActionFormOptions {
  operation: Operation;
  title?: CopyKey;
  submit: CopyKey;
  fields?: FieldSpec[];
  input?: () => ActionInput;
  transform?: (values: ActionInput) => ActionInput;
  onSuccess?: (value: unknown) => void;
  display?: (value: unknown) => unknown;
  resultMessage?: (value: unknown) => CopyKey | undefined;
}

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
  const submit = el('button', { type: 'submit' }, context.t(options.submit));
  // Keep command identity on an uncertain transport result. A changed input is a new command.
  let commandKey = crypto.randomUUID();
  let priorInput: string | null = null;
  let inFlight = false;
  const reset = button(context.t('newAction'), () => {
    if (inFlight) return;
    commandKey = crypto.randomUUID();
    priorInput = null;
    output.replaceChildren();
  }, 'secondary');
  append(form, el('p', { class: 'muted small' }, context.t('idempotency')),
    el('div', { class: 'actions' }, submit, reset), output);
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (inFlight || !form.reportValidity()) return;
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
      const serialized = JSON.stringify(values);
      if (priorInput !== null && priorInput !== serialized) commandKey = crypto.randomUUID();
      priorInput = serialized;
      inFlight = true;
      submit.disabled = true;
      reset.disabled = true;
      form.setAttribute('aria-busy', 'true');
      output.replaceChildren(el('p', {}, context.t('loading')));
      try {
        const result = await act(options.operation, values, commandKey);
        output.replaceChildren(result.ok
          ? el('section', {}, el('h4', {}, context.t('response')),
            options.resultMessage?.(result.value) ? el('p', {}, context.t(options.resultMessage(result.value)!)) : null,
            renderValue(options.display ? options.display(result.value) : result.value))
          : refusal(context, result.code, operationLimits[options.operation]?.code === result.code ? operationLimits[options.operation]!.explanation[context.locale] : undefined));
        if (result.ok) {
          for (const { spec, control } of controls) if (spec.type === 'password') control.value = '';
          options.onSuccess?.(result.value);
        }
      } finally {
        inFlight = false;
        submit.disabled = false;
        reset.disabled = false;
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
