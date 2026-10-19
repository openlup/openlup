import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => { vi.unstubAllEnvs(); });
it('selected build defines only explicit public auth settings and disables external sign-in', async () => {
  vi.resetModules();
  vi.stubEnv('OPENLUP_REFERENCE_PROFILE', 'subscription');
  vi.stubEnv('SUPABASE_URL', 'http://127.0.0.1:56421');
  vi.stubEnv('SUPABASE_ANON_KEY', 'synthetic-public-key');
  vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'synthetic-private-key');
  const { publicReferenceViteConfig } = await import('../../vite.public-reference.config');
  const config = publicReferenceViteConfig();
  const document = (config.plugins as Array<{ name?: string; transformIndexHtml?: { handler: () => string } }>).find((entry) => entry.name === 'public-reference-document')!.transformIndexHtml!.handler();
  expect(document).toContain('<html lang="en" data-openlup-profile="subscription">');
  expect(document).toContain('/src/public-reference/subscription-main.tsx');
  expect(config.envPrefix).toEqual([]);
  const definitions: Record<string, string> = {};
  const plugin = (config.plugins as Array<{ name?: string; configResolved?: (config: unknown) => void }>).find((entry) => entry.name === 'public-reference-auth-settings')!;
  plugin.configResolved!({ env: definitions });
  expect(Object.keys(definitions).map((key) => key.split('.').pop()).sort()).toEqual(['VITE_COMMERCE_AUTH_PROVIDER_KIND', 'VITE_COMMERCE_SOCIAL_PROVIDERS', 'VITE_SUPABASE_PUBLISHABLE_KEY', 'VITE_SUPABASE_URL']);
  expect(Object.values(definitions)).toContain('synthetic-public-key');
  expect(Object.values(definitions)).toContain('http://127.0.0.1:56421');
  expect(Object.values(definitions)).not.toContain('synthetic-private-key');
  const social = Object.entries(definitions).find(([key]) => key.endsWith('SOCIAL_PROVIDERS'));
  expect(social?.[1]).toBe('');
});
it('static build exposes no auth settings and retains exact import refusal', async () => {
  vi.resetModules(); vi.stubEnv('OPENLUP_REFERENCE_PROFILE', '');
  const { publicReferenceViteConfig, assertPublicReferenceModuleId } = await import('../../vite.public-reference.config');
  const config = publicReferenceViteConfig();
  const document = (config.plugins as Array<{ name?: string; transformIndexHtml?: { handler: () => string } }>).find((entry) => entry.name === 'public-reference-document')!.transformIndexHtml!.handler();
  expect(document).not.toContain('data-openlup-profile=');
  expect(document).toContain('/src/public-reference/main.tsx');
  const env = {};
  const plugin = (config.plugins as Array<{ name?: string; configResolved?: (config: unknown) => void }>).find((entry) => entry.name === 'public-reference-auth-settings')!;
  plugin.configResolved!({ env });
  expect(env).toEqual({});
  const files: string[] = JSON.parse(readFileSync('config/public-reference-subscription-imports.json', 'utf8')).files;
  expect(files.some((file) => file.includes('*'))).toBe(false);
  for (const file of ['src/pages/account/LoginPage.tsx', 'src/pages/account/AuthCallbackPage.tsx', 'src/lib/useCustomerAuth.tsx', 'src/lib/queryClient.ts', 'src/integrations/postgres/customerAuthPort.ts', 'src/integrations/supabase/customerAuthPort.ts']) {
    expect(() => assertPublicReferenceModuleId(resolve(file), process.cwd(), files)).not.toThrow();
    expect(() => assertPublicReferenceModuleId(resolve(file))).toThrow('outside declared profile');
  }
  expect(() => assertPublicReferenceModuleId(resolve('src/lib/useAuth.tsx'), process.cwd(), files)).toThrow('outside declared profile');
});
