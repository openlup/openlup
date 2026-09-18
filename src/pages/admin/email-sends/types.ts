import type { AdminEmailEvent, AdminEmailSend } from '@/domains/communications/contracts';

export type EmailSend = Omit<AdminEmailSend, 'testers'>;

export type EmailEvent = AdminEmailEvent;

export type EmailSendWithTester = AdminEmailSend;

export const PAGE_SIZE = 20;
