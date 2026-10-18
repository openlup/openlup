import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEnabledSocialProviders } from '@/lib/auth/socialProviders';

// The configured list is filtered against selected adapter capabilities.
describe('getEnabledSocialProviders', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('honours a configured comma-separated list', () => {
    vi.stubEnv('VITE_COMMERCE_SOCIAL_PROVIDERS', 'google,apple');
    expect(getEnabledSocialProviders()).toEqual(['google', 'apple']);
  });

  it('drops unknown tokens and de-duplicates', () => {
    vi.stubEnv('VITE_COMMERCE_SOCIAL_PROVIDERS', 'google, google, sms');
    expect(getEnabledSocialProviders()).toEqual(['google']);
  });

  it('disables social sign-in for an explicit empty value', () => {
    vi.stubEnv('VITE_COMMERCE_SOCIAL_PROVIDERS', '');
    expect(getEnabledSocialProviders()).toEqual([]);
  });
});
