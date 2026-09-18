import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { EmailSendDetailPanel } from './EmailSendDetailPanel';
import type { EmailSendWithTester } from './types';

describe('EmailSendDetailPanel', () => {
  it('shows operator-safe send details without rendering provider payloads', () => {
    const send = {
      id: 'send-1',
      tester_id: 'tester-1',
      template_slug: 'approved',
      resend_id: 'resend-1',
      sent_at: '2024-01-10T10:00:00.000Z',
      status: 'failed',
      source: 'book-dhl-courier',
      provider_error: 'rate limited',
      provider_response: {
        emailBaseUrl: 'https://hidden-preview.example.com',
        emailEnvironment: 'hidden_preview',
        triggerSource: 'process-email-queue',
        triggerReason: 'feedback-mid',
        html: '<p>private rendered body</p>',
        to: ['payload-only@example.com'],
      },
      testers: {
        first_name: 'Jan',
        last_name: 'Kowalski',
        email: 'jan@example.com',
      },
    } as unknown as EmailSendWithTester;

    render(<EmailSendDetailPanel send={send} events={[]} />);

    expect(screen.getByText('Raport supportowy')).toBeInTheDocument();
    expect(screen.getByText('Jan Kowalski <jan@example.com>')).toBeInTheDocument();
    expect(screen.getByText('process-email-queue')).toBeInTheDocument();
    expect(screen.getByText('feedback-mid')).toBeInTheDocument();
    expect(screen.getByText('hidden_preview')).toBeInTheDocument();
    expect(screen.getByText('https://hidden-preview.example.com')).toBeInTheDocument();
    expect(screen.getByText('resend-1')).toBeInTheDocument();
    expect(screen.getByText('failed: rate limited')).toBeInTheDocument();
    expect(screen.getByText('Brak zdarzeń dla tej wysyłki.')).toBeInTheDocument();
    expect(screen.queryByText(/private rendered body/i)).not.toBeInTheDocument();
    expect(screen.queryByText('payload-only@example.com')).not.toBeInTheDocument();
  });
});
