import { createSupabaseCustomerAuthPort } from '@/integrations/supabase/customerAuthPort';
import { createPostgresCustomerAuthPort } from '@/integrations/postgres/customerAuthPort';
import type { CustomerAuthPort } from '@/domains/auth/ports';

// Brand-layer composition: selects the customer auth provider adapter. Lives in
// src/lib (NOT src/domains/auth) so the OSS core stays free of adapter imports —
// an adopter swaps the adapter here, or sets VITE_COMMERCE_AUTH_PROVIDER_KIND.
// Only `supabase` ships today.

export function getCustomerAuthPort(): CustomerAuthPort {
  const kind = import.meta.env.VITE_COMMERCE_AUTH_PROVIDER_KIND;
  if (kind === 'postgres' || kind === 'node-postgres') {
    return createPostgresCustomerAuthPort();
  }
  return createSupabaseCustomerAuthPort();
}
