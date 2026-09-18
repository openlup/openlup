type SupabaseBrowserKeyEnv = {
  VITE_SUPABASE_PUBLISHABLE_KEY?: string;
  VITE_SUPABASE_ANON_KEY?: string;
};

export function resolveSupabasePublishableKey(env: SupabaseBrowserKeyEnv): string {
  const canonical = env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ?? "";
  const legacyAlias = env.VITE_SUPABASE_ANON_KEY?.trim() ?? "";

  return canonical || legacyAlias;
}
