import { useState } from 'react';
import { readLoginHint, clearLoginHint } from '@/lib/customerLoginHint';

/** Optional method-only returning hint; never an authentication identity. */
export function useLoginHint() {
  const [hint, setHint] = useState(readLoginHint);
  return { hint, forget() { clearLoginHint(); setHint(null); } };
}
