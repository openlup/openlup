import type { PageContext } from '../context.ts';
import { actionForm } from '../forms.ts';
import { el } from '../dom.ts';
import { acquisitionAddresses } from '../../owned/acquisition-addresses.ts';

export function acquisitionPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('acquisition')),
    el('p', {}, context.t('acquisitionBody')),
    el('p', {}, context.t('demoContact')),
    actionForm(context, {
      operation: 'acquisition.submit', submit: 'apply',
      fields: [
        { name: 'addressChoiceId', label: 'acquisitionAddress', type: 'select',
          options: acquisitionAddresses.map(choice => ({ value: choice.id, text: choice.label[context.locale] })) },
        { name: 'email', label: 'email', type: 'email', value: 'applicant@example.test' },
        { name: 'consent', label: 'consent', type: 'checkbox' },
      ],
    }));
}

export function researchPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('research')),
    el('p', {}, context.t('researchBody')),
    actionForm(context, {
      operation: 'research.submit', submit: 'submit',
      fields: [
        { name: 'caseReference', label: 'caseRef' },
        { name: 'surveyType', label: 'surveyType', type: 'select', options: [
          { value: 'consumer', text: context.t('consumer') },
          { value: 'producer', text: context.t('producer') },
        ] },
        { name: 'feedback', label: 'feedback', type: 'textarea' },
      ],
      transform: values => ({ view: 'acquisition_survey_v1', caseReference: values.caseReference,
        surveyType: values.surveyType, responseData: { feedback: values.feedback } }),
    }));
}

export function partnersPage(context: PageContext): HTMLElement {
  return el('div', {}, el('h1', {}, context.t('partners')),
    el('p', {}, context.t('partnersBody')),
    el('p', {}, context.t('demoContact')),
    actionForm(context, {
      operation: 'partners.submit', submit: 'sendInquiry',
      fields: [
        { name: 'company', label: 'company', value: context.t('demoCompany') },
        { name: 'firstName', label: 'firstName', value: context.t('demoFirstName') },
        { name: 'lastName', label: 'lastName', value: context.t('demoPartner') },
        { name: 'email', label: 'email', type: 'email', value: 'partner@example.test' },
        { name: 'phone', label: 'phone', type: 'tel', required: false },
        { name: 'notes', label: 'partnerNotes', type: 'textarea', required: false },
      ], input: () => ({ country: context.config.market.country, policyVersion: context.config.legal.revision }),
    }));
}
