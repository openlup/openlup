import { act, render, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { BffClientError } from '@/lib/bff/client';
const { verify, request } = vi.hoisted(() => ({ verify: vi.fn(async () => ({ error: null })), request: vi.fn(async () => ({ accepted: true })) }));
vi.mock('@/lib/authContext', () => ({ useAuth: () => ({ directOperatorAuth: true, signIn: vi.fn(), signInWithOtpCode: verify }) }));
vi.mock('@/domains/platform/adminMagicLinkClient', () => ({ requestAdminMagicLink: request }));
import LoginPage from './LoginPage';
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });
it('direct shell offers email and pasted token without password or numeric code', async () => {
  vi.stubEnv('VITE_OPERATOR_AUTH_PROVIDER_KIND', 'direct');
  const { container } = render(<MemoryRouter><LoginPage /></MemoryRouter>);
  expect(container.querySelector('input[type=password]')).toBeNull();
  fireEvent.change(container.querySelector('input[type=email]')!, { target: { value: 'admin@example.invalid' } });
  fireEvent.click(screen.getByRole('button', { name: /link/i }));
  const token = await screen.findByLabelText('Email link token');
  expect(token.getAttribute('inputmode')).toBe('text');
  fireEvent.change(token, { target: { value: 'a'.repeat(43) } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in with token' }));
  expect(verify).toHaveBeenCalledWith('admin@example.invalid', 'a'.repeat(43));
});

const privacy = vi.hoisted(() => ({ export: vi.fn(), erase: vi.fn() }));
vi.mock('@/domains/auth/privacyClient', () => ({ exportIdentityPersonalData: privacy.export, eraseIdentityPersonalData: privacy.erase }));
import { IdentityPrivacyPanel } from './IdentityPrivacyPanel';
it('privacy panel clears personal readback and confirmation on subject change, including late responses', async () => {
  const C = '11111111-1111-4111-8111-111111111111', P = '22222222-2222-4222-8222-222222222222';
  privacy.export.mockResolvedValueOnce({ documents: [{ data: 'person@example.com' }] });
  render(<IdentityPrivacyPanel accessToken="synthetic-token" />);
  fireEvent.change(screen.getByLabelText('Subject ID'), { target: { value: C } });
  expect(screen.getByRole('button', { name: 'Erase identity data' })).toBeDisabled();
  fireEvent.click(screen.getByRole('button', { name: 'Export identity data' }));
  await screen.findByText(/person@example.com/);
  fireEvent.click(screen.getByLabelText('Confirm identity erasure for this subject'));
  privacy.erase.mockResolvedValueOnce({ erasureId: C, outcome: 'ERASED', obligations: [] });
  fireEvent.click(screen.getByRole('button', { name: 'Erase identity data' }));
  await screen.findByText('Committed erasure receipt');
  expect(privacy.erase).toHaveBeenCalledWith('synthetic-token', expect.objectContaining({ subject: { kind: 'contact', contactId: C }, idempotencyKey: expect.any(String) }));
  fireEvent.change(screen.getByLabelText('Subject ID'), { target: { value: P } });
  expect(screen.queryByText('Committed erasure receipt')).toBeNull();
  expect(screen.queryByText(/person@example.com/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Erase identity data' })).toBeDisabled();
  let finish: (value: unknown) => void = () => {};
  privacy.export.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  fireEvent.click(screen.getByRole('button', { name: 'Export identity data' }));
  fireEvent.change(screen.getByLabelText('Subject ID'), { target: { value: C } });
  finish({ documents: [{ data: 'late@example.com' }] });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Export identity data' })).toBeEnabled());
  expect(screen.queryByText(/late@example.com/)).toBeNull();
});

const C = "11111111-1111-4111-8111-111111111111";
const occurrenceDocument = {
  contributorId: "subscriptions", version: "subscriptions.privacy-veto.v1", data: [{ id: C, status: "cancelled" }],
  coverage: { complete: false, included: ["subscription IDs and statuses", "renewal occurrence evidence"],
    unavailable: ["full subscription export", "processor obligations"] }, obligations: [],
  renewalOccurrences: [{ subscriptionId: C, cycleKey: C, rail: "v3", lifecycle: "active",
    originalAnchorAt: "2035-01-01T00:00:00.123456Z", effectiveDueAt: "2035-01-01T00:00:00.123456Z", cancellationEffectiveAt: null }],
};
it("renders occurrence evidence with its export coverage", async () => {
  privacy.export.mockResolvedValueOnce({ documents: [occurrenceDocument] });
  render(<IdentityPrivacyPanel accessToken="synthetic-token" />);
  fireEvent.change(screen.getByLabelText('Subject ID'), { target: { value: C } });
  fireEvent.click(screen.getByRole('button', { name: 'Export identity data' }));
  expect(await screen.findByText(/"renewalOccurrences"/)).toHaveTextContent("2035-01-01T00:00:00.123456Z");
});
it("browser client uses strict contracts, authenticated POSTs and no storage or cache", async () => {
  const { exportIdentityPersonalData, eraseIdentityPersonalData } = await vi.importActual<typeof import('@/domains/auth/privacyClient')>('@/domains/auth/privacyClient');
  const exported = { format: "personal-data.v1", generatedAt: "2035-01-01T00:00:00.000Z", subject: { kind: "contact", contactId: C }, documents: [occurrenceDocument], missingContributors: ["identity"], erasure: null };
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ ok: true, data: exported }), { status: 200, headers: { "Content-Type": "application/json" } }));
  expect(await exportIdentityPersonalData("synthetic-token", { kind: "contact", contactId: C }, { fetcher })).toEqual(exported);
  expect(fetcher).toHaveBeenCalledWith("/api/bff/admin/identity/privacy/export", expect.objectContaining({ method: "POST", cache: "no-store", body: JSON.stringify({ subject: exported.subject }) }));
  expect(new Headers(fetcher.mock.calls[0][1]?.headers).get("Authorization")).toBe("Bearer synthetic-token");
  expect(() => eraseIdentityPersonalData("synthetic-token", { subject: { kind: "contact", contactId: C }, idempotencyKey: "invalid" }, { fetcher })).toThrow();
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it('privacy panel discards an export pending across an access token change', async () => {
  let finish: (value: unknown) => void = () => {};
  privacy.export.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
  const { rerender } = render(<IdentityPrivacyPanel accessToken="old-session" />);
  fireEvent.change(screen.getByLabelText('Subject ID'), { target: { value: C } });
  fireEvent.click(screen.getByLabelText('Confirm identity erasure for this subject'));
  fireEvent.click(screen.getByRole('button', { name: 'Export identity data' }));
  expect(privacy.export).toHaveBeenCalledWith('old-session', { kind: 'contact', contactId: C });
  rerender(<IdentityPrivacyPanel accessToken="new-session" />);
  await act(async () => { finish({ documents: [{ data: 'old-session@example.com' }] }); });
  expect(screen.queryByText(/old-session@example.com/)).toBeNull();
  expect(screen.getByRole('button', { name: 'Erase identity data' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Export identity data' })).toBeEnabled();
  privacy.export.mockResolvedValueOnce({ documents: [{ data: 'new-session@example.com' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Export identity data' }));
  await screen.findByText(/new-session@example.com/);
  expect(privacy.export).toHaveBeenLastCalledWith('new-session', { kind: 'contact', contactId: C });
});

const coverageCode = 'PRIVACY_RECEIPT_COVERAGE_INCOMPLETE';
const ownerCode = 'PRIVACY_RECONCILIATION_APPROVAL_UNVERIFIED';
const facts = {
  observed: 'A prior erasure is missing recorded coverage for the required owners (customer-saved-addresses).',
  cause: 'The original receipt and verified owner approvals do not establish their local disposition.',
  fix: 'Ask the data privacy owner and contributor owners to reconcile the missing coverage against the original receipt.',
  recheck: 'Retry the original erasure request after reconciliation.',
};
const governed = { privacyCode: coverageCode, ...facts };
const fallback = 'Privacy operation unavailable';
const heading = 'Export coverage and retained obligations';
function refusal(details: unknown, status = 503, code: BffClientError['code'] = 'UPSTREAM_UNAVAILABLE') {
  return new BffClientError({ code, message: 'Private adapter diagnostic', details }, status);
}
function openPrivacyPanel() {
  render(<IdentityPrivacyPanel accessToken="synthetic-token" />);
  fireEvent.change(screen.getByLabelText('Subject ID'), { target: { value: C } });
  return screen.getByRole('button', { name: 'Export identity data' });
}

function pendingExport() {
  let resolve!: (value: unknown) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  privacy.export.mockReturnValueOnce(promise);
  return { resolve, reject };
}

it('removes the current export as soon as a refresh starts and keeps it absent on refusal', async () => {
  const exportButton = openPrivacyPanel();
  privacy.export.mockResolvedValueOnce({ documents: [{ data: 'old-report@example.invalid' }] });
  fireEvent.click(exportButton);
  await screen.findByRole('heading', { name: heading });
  await screen.findByText(/old-report@example.invalid/);

  const pending = pendingExport();
  fireEvent.click(exportButton);
  expect(exportButton).toBeDisabled();
  expect(screen.queryByRole('heading', { name: heading })).toBeNull();
  expect(screen.queryByText(/old-report@example.invalid/)).toBeNull();
  await act(async () => { pending.reject(refusal(governed)); });
  expect(screen.getByRole('alert')).toBeVisible();
  expect(screen.queryByRole('heading', { name: heading })).toBeNull();
  expect(screen.queryByText(/old-report@example.invalid/)).toBeNull();

  const fresh = pendingExport();
  fireEvent.click(exportButton);
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('heading', { name: heading })).toBeNull();
  await act(async () => { fresh.resolve({ documents: [{ data: 'fresh-report@example.invalid' }] }); });
  expect(screen.getByRole('heading', { name: heading })).toBeVisible();
  expect(screen.getByText(/fresh-report@example.invalid/)).toBeVisible();
});

it.each([coverageCode, 'PRIVACY_CONTRIBUTOR_MISSING', 'PRIVACY_ASSESSMENT_UNAVAILABLE'])(
  'renders the four governed facts for %s in display order', async privacyCode => {
    const exportButton = openPrivacyPanel();
    const reason = refusal({ privacyCode, ...facts });
    Object.defineProperty(reason, 'cause', { value: new Error('Private driver diagnostic') });
    privacy.export.mockRejectedValueOnce(reason);
    fireEvent.click(exportButton);
    const alert = await screen.findByRole('alert');
    expect([...alert.querySelectorAll('dt, dd')].map(node => node.textContent)).toEqual([
      'Observed', facts.observed, 'Cause', facts.cause, 'Fix', facts.fix, 'Recheck', facts.recheck,
    ]);
    expect(within(alert).queryByText(/Private .* diagnostic/)).toBeNull();
  },
);

const factLimits = { observed: 1_020_100, cause: 1_024, fix: 1_024, recheck: 1_024 } as const;
const invalidFacts = Object.entries(factLimits).flatMap(([key, limit]) => {
  const missing = { ...governed };
  Reflect.deleteProperty(missing, key);
  return [
    { name: `missing ${key}`, error: () => refusal(missing) },
    ...([
      ['object', () => ({ value: 'private detail' })],
      ['empty', () => ''],
      ['blank', () => ' '],
      ['overlong', () => 'a'.repeat(limit + 1)],
    ] as const).map(([kind, value]) => ({ name: `${kind} ${key}`, error: () => refusal({ ...governed, [key]: value() }) })),
  ];
});

it.each([
  ...invalidFacts,
  { name: 'missing privacy code', error: () => refusal(facts) },
  { name: 'extra repair key', error: () => refusal({ ...governed, repair: 'private value' }) },
  { name: 'extra symbol key', error: () => refusal({ ...governed, [Symbol('extra')]: true }) },
  { name: 'non-plain record', error: () => refusal(Object.assign(Object.create({ inherited: true }), governed)) },
  { name: 'wrong HTTP status', error: () => refusal(governed, 409) },
  { name: 'wrong BFF code', error: () => refusal(governed, 503, 'CONFLICT') },
  { name: 'known code without governed facts', error: () => refusal({ ...governed, privacyCode: 'PRIVACY_ACTIVE_SUBSCRIPTION' }) },
  { name: 'fabricated code', error: () => refusal({ privacyCode: 'private value' }) },
  { name: 'owner-only code', error: () => refusal({ privacyCode: ownerCode }) },
  { name: 'owner-only facts', error: () => refusal({ ...governed, privacyCode: ownerCode }) },
  { name: 'non-BFF error', error: () => new Error('Private adapter diagnostic') },
])('uses the fixed fallback for $name', async ({ error }) => {
  const exportButton = openPrivacyPanel();
  privacy.export.mockRejectedValueOnce(error());
  fireEvent.click(exportButton);
  expect(await screen.findByRole('alert')).toHaveTextContent(fallback);
  expect(screen.getByRole('alert').textContent).toBe(fallback);
});

it.each([
  ['PRIVACY_SUBJECT_NOT_FOUND', 404, 'NOT_FOUND'],
  ['PRIVACY_IDEMPOTENCY_CONFLICT', 409, 'CONFLICT'],
  ['MANAGED_PRIVACY_ERASURE_UNAVAILABLE', 503, 'UPSTREAM_UNAVAILABLE'],
  ['PRIVACY_ASSESSMENT_UNAVAILABLE', 503, 'UPSTREAM_UNAVAILABLE'],
] as const)('keeps the code-only display for %s', async (privacyCode, status, code) => {
  const exportButton = openPrivacyPanel();
  privacy.export.mockRejectedValueOnce(refusal({ privacyCode }, status, code));
  fireEvent.click(exportButton);
  expect((await screen.findByRole('alert')).textContent).toBe(privacyCode);
});

it('keeps the committed receipt, confirmation and key through a refresh and same-subject retry', async () => {
  const exportButton = openPrivacyPanel();
  const confirmation = screen.getByLabelText('Confirm identity erasure for this subject');
  const eraseButton = screen.getByRole('button', { name: 'Erase identity data' });
  fireEvent.click(confirmation);
  const receipt = { erasureId: C, outcome: 'ERASED', obligations: [] };
  privacy.erase.mockResolvedValueOnce(receipt);
  fireEvent.click(eraseButton);
  await screen.findByRole('heading', { name: 'Committed erasure receipt' });

  privacy.export.mockRejectedValueOnce(refusal(governed));
  fireEvent.click(exportButton);
  await screen.findByRole('alert');
  expect(confirmation).toBeChecked();
  expect(screen.getByRole('heading', { name: 'Committed erasure receipt' })).toBeVisible();
  expect(screen.getByText(/"outcome": "ERASED"/)).toBeVisible();

  privacy.erase.mockResolvedValueOnce({ ...receipt, outcome: 'ALREADY_ERASED' });
  fireEvent.click(eraseButton);
  await screen.findByText(/"outcome": "ALREADY_ERASED"/);
  const original = privacy.erase.mock.calls[0]?.[1];
  expect(original.idempotencyKey).toEqual(expect.any(String));
  expect(privacy.erase).toHaveBeenNthCalledWith(2, 'synthetic-token', original);
});
