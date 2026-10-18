import { useState, useEffect, useRef } from 'react';
import { loadManagedAdminAuth } from '@/integrations/supabase/adminAuthPort';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from "../../lib/validation/zod.js";
import type { AdminSession as Session } from '@/domains/auth/adminAuth';
import { ConfirmPasswordField } from '@/components/forms/fields/ConfirmPasswordField';
import { PasswordField } from '@/components/forms/fields/PasswordField';
import { Form } from '@/components/ui/form';
import { useAuth } from '@/lib/authContext';
import { brandMarkInverse as veliLogoWhite } from "#deployment-media";

const passwordUpdateSchema = z
  .object({
    confirmPassword: z.string().min(1, 'forms:fields.confirmPassword.required'),
    password: z.string().min(1, 'forms:fields.password.required').min(8, 'forms:fields.password.tooShort'),
  })
  .refine((values) => values.password === values.confirmPassword, {
    message: 'forms:fields.confirmPassword.mismatch',
    path: ['confirmPassword'],
  });

type PasswordUpdateValues = z.infer<typeof passwordUpdateSchema>;

const inputCls =
  'h-auto w-full rounded-xl border-[1.5px] border-warm-sand bg-offwhite px-4 py-3 text-sm text-teal-dark outline-hidden transition-colors focus:border-teal focus:ring-[3px] focus:ring-teal/12';
const fieldItemCls =
  'text-text-muted [&>label]:label-text [&>label]:mb-0 [&>label]:block [&>label]:text-text-muted [&>label>span]:text-warm-coral [&>p]:font-body [&>p]:text-xs-plus [&>p]:text-warm-coral [&>p]:mt-1';

export default function AuthCallbackPage() {
  const { directOperatorAuth } = useAuth();
  return directOperatorAuth ? <DirectOperatorCallback /> : <ManagedAuthCallback />;
}
function DirectOperatorCallback() {
  const { signInWithOtpCode } = useAuth();
  const navigate = useNavigate();
  const token = useRef(new URLSearchParams(window.location.hash.slice(1)).get('operator_token'));
  const attempt = useRef<Promise<{ error: string | null }> | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let cancelled = false;
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
    attempt.current ??= token.current ? signInWithOtpCode('', token.current) : Promise.resolve({ error: 'Operator challenge invalid or expired' });
    void attempt.current.then(result => {
      if (cancelled) return;
      if (result.error) setError('Operator challenge invalid or expired');
      else navigate('/admin', { replace: true });
    });
    return () => { cancelled = true; };
  }, [navigate, signInWithOtpCode]);
  return <div className="flex min-h-screen items-center justify-center bg-offwhite"><p>{error || 'Verifying operator sign-in…'}</p>{error && <a href="/admin/login">Return to sign in</a>}</div>;
}
function ManagedAuthCallback() {
  const navigate = useNavigate();
  const { refreshAdmin } = useAuth();
  const passwordForm = useForm<PasswordUpdateValues>({
    defaultValues: {
      confirmPassword: '',
      password: '',
    },
    resolver: zodResolver(passwordUpdateSchema),
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ready, setReady] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    let cancelled = false;

    async function completeMagicLink(session: Session | null) {
      if (!session) {
        if (!cancelled) {
          setReady(false);
          setChecking(false);
        }
        return;
      }

      const admin = await refreshAdmin(session);
      if (cancelled) return;

      if (admin.isAdmin) {
        navigate('/admin', { replace: true });
        return;
      }

      const { supabase } = await loadManagedAdminAuth();
      await supabase.auth.signOut();
      if (!cancelled) {
        setError('Nie masz dostępu do panelu admina.');
        setReady(false);
        setChecking(false);
      }
    }

    let unsubscribe = () => {};
    void loadManagedAdminAuth().then(({ supabase, initialAuthCallbackType, readAuthCallbackTypeFrom }) => {
    if (cancelled) return;
    const isMagicLinkCallback = (initialAuthCallbackType ?? readAuthCallbackTypeFrom(window.location.search, window.location.hash)) === 'magiclink';
    // Supabase auto-exchanges the token from the URL hash into a session.
    // We listen for the PASSWORD_RECOVERY or SIGNED_IN event (invite counts as recovery).
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'PASSWORD_RECOVERY' || event === 'SIGNED_IN') {
        if (isMagicLinkCallback) {
          void completeMagicLink(session ?? null);
          return;
        }
        setReady(true);
        setChecking(false);
      }
    });

    // Fallback: if there's already a session (token was already exchanged)
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (cancelled) return;
      if (isMagicLinkCallback) {
        void completeMagicLink(session ?? null);
        return;
      }
      if (session) {
        setReady(true);
      }
      setChecking(false);
    });

    unsubscribe = () => subscription.unsubscribe();
    });
    return () => { cancelled = true; unsubscribe(); };
  }, [navigate, refreshAdmin]);

  async function handleSubmit(values: PasswordUpdateValues) {
    setError('');

    setLoading(true);
    const { supabase } = await loadManagedAdminAuth();
    const { error: updateError } = await supabase.auth.updateUser({ password: values.password });

    if (updateError) {
      setError(updateError.message);
      setLoading(false);
      return;
    }

    navigate('/admin', { replace: true });
  }

  if (checking) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-offwhite">
        <p className="text-text-muted text-sm">Weryfikacja...</p>
      </div>
    );
  }

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-offwhite px-4">
        <div className="w-full max-w-sm space-y-6 rounded-2xl border border-warm-sand bg-white p-8 text-center">
          <img src={veliLogoWhite} alt="openlup" className="h-[32px] w-auto mx-auto" />
          <p className="text-sm text-red-400">{error || 'Link jest nieprawidłowy lub wygasł. Poproś administratora o ponowne zaproszenie.'}</p>
          <a href="/admin/login" className="inline-block text-sm text-teal hover:underline">Wróć do logowania</a>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-offwhite px-4">
      <Form {...passwordForm}>
        <form
          onSubmit={passwordForm.handleSubmit(handleSubmit, () => setError(''))}
          className="w-full max-w-sm space-y-6 rounded-2xl border border-warm-sand bg-white p-8"
        >
          <div className="text-center">
            <img src={veliLogoWhite} alt="openlup" className="h-[32px] w-auto mx-auto" />
            <p className="mt-3 text-sm text-text-muted">Ustaw hasło do panelu</p>
          </div>

          {error && (
            <div className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
          )}

          <div className="space-y-4">
            <PasswordField
              autoComplete="new-password"
              className={fieldItemCls}
              control={passwordForm.control}
              inputClassName={inputCls}
              label="Nowe hasło"
              name="password"
              placeholder="Min. 8 znaków"
              required
            />
            <ConfirmPasswordField
              className={fieldItemCls}
              control={passwordForm.control}
              inputClassName={inputCls}
              label="Powtórz hasło"
              name="confirmPassword"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full rounded-xl bg-teal py-3 text-sm font-semibold text-void transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Zapisywanie...' : 'Ustaw hasło i wejdź'}
          </button>
        </form>
      </Form>
    </div>
  );
}
