import { useState } from 'react';
import { zodResolver } from '@hookform/resolvers/zod';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import { z } from "../../lib/validation/zod.js";
import { EmailField } from '@/components/forms/fields/EmailField';
import { PasswordField } from '@/components/forms/fields/PasswordField';
import { Form } from '@/components/ui/form';
import { requestAdminMagicLink } from '@/domains/platform/adminMagicLinkClient';
import { useAuth } from '@/lib/authContext';
import { emailFieldSchema } from '@/lib/schemas/fields';
import { brandMarkInverse as veliLogoWhite } from "#deployment-media";

const loginSchema = z.object({
  email: emailFieldSchema(),
  password: z.string().min(1, 'forms:fields.password.required'),
});

type LoginFormInput = z.input<typeof loginSchema>;
type LoginValues = z.output<typeof loginSchema>;

const inputCls =
  'h-auto w-full rounded-xl border-[1.5px] border-warm-sand bg-offwhite px-4 py-3 text-sm text-teal-dark outline-hidden transition-colors focus:border-teal focus:ring-[3px] focus:ring-teal/12';
const fieldItemCls =
  'text-text-muted [&>label]:label-text [&>label]:mb-0 [&>label]:block [&>label]:text-text-muted [&>label>span]:text-warm-coral [&>p]:font-body [&>p]:text-xs-plus [&>p]:text-warm-coral [&>p]:mt-1';

// The email OTP code is the digits-only fallback printed in the magic-link email
// ("Nie działa link? Wpisz ten kod na stronie logowania: 77323522"). Accept 6–8
// digits (Supabase email OTP length).
const isLikelyOtpCode = (value: string): boolean => /^\d{6,8}$/.test(value.trim());

export default function LoginPage() {
  const { signIn, signInWithOtpCode } = useAuth();
  const navigate = useNavigate();
  const loginForm = useForm<LoginFormInput, unknown, LoginValues>({
    defaultValues: {
      email: '',
      password: '',
    },
    resolver: zodResolver(loginSchema),
  });
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [magicLinkLoading, setMagicLinkLoading] = useState(false);
  const [magicLinkMessage, setMagicLinkMessage] = useState('');
  // After a magic link is sent, offer the email's OTP code as a fallback so the
  // operator isn't blocked if the email link itself fails to open/verify.
  const [magicLinkSentTo, setMagicLinkSentTo] = useState('');
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState('');
  const [codeLoading, setCodeLoading] = useState(false);

  async function handleSubmit(values: LoginValues) {
    setError('');
    setLoading(true);

    const result = await signIn(values.email, values.password);

    if (result.error) {
      setError(result.error);
      setLoading(false);
    } else {
      navigate('/admin', { replace: true });
    }
  }

  async function handleMagicLinkRequest() {
    setError('');
    setMagicLinkMessage('');
    const parsedEmail = emailFieldSchema({ required: true }).safeParse(loginForm.getValues('email'));
    if (!parsedEmail.success) {
      const rawEmail = String(loginForm.getValues('email') ?? '').trim();
      loginForm.setError('email', {
        type: 'manual',
        message: rawEmail ? 'forms:fields.email.invalid' : 'forms:fields.email.required',
      });
      return;
    }

    setMagicLinkLoading(true);
    loginForm.clearErrors('email');
    loginForm.setValue('email', parsedEmail.data, { shouldDirty: true });

    try {
      await requestAdminMagicLink(parsedEmail.data);
      setMagicLinkMessage('Jeśli ten adres ma dostęp, wyślemy link. Możesz też wpisać kod z e-maila poniżej.');
      setMagicLinkSentTo(parsedEmail.data);
      setCode('');
      setCodeError('');
    } catch {
      setError('Nie udało się wysłać linku. Spróbuj ponownie za chwilę.');
    } finally {
      setMagicLinkLoading(false);
    }
  }

  async function handleCodeSubmit() {
    setError('');
    setCodeError('');
    if (!isLikelyOtpCode(code)) {
      setCodeError('Wpisz kod z e-maila (6–8 cyfr).');
      return;
    }

    setCodeLoading(true);
    try {
      const result = await signInWithOtpCode(magicLinkSentTo, code.trim());
      if (result.error) {
        setCodeError('Nieprawidłowy lub wygasły kod. Wyślij link ponownie.');
        return;
      }
      navigate('/admin', { replace: true });
    } finally {
      setCodeLoading(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-offwhite px-4">
      <Form {...loginForm}>
        <form
          onSubmit={loginForm.handleSubmit(handleSubmit, () => setError(''))}
          className="w-full max-w-sm space-y-6 rounded-2xl border border-warm-sand bg-white p-8"
        >
          <div className="text-center">
            <img src={veliLogoWhite} alt="openlup" className="h-[32px] w-auto mx-auto" />
            <p className="mt-3 text-sm text-text-muted">Panel admina</p>
          </div>

          {error && (
            <div className="rounded-lg bg-red-500/10 px-4 py-3 text-sm text-red-400">{error}</div>
          )}

          <div className="space-y-4">
            <EmailField
              className={fieldItemCls}
              control={loginForm.control}
              inputClassName={inputCls}
              label="Email"
              name="email"
              required
            />
            <PasswordField
              className={fieldItemCls}
              control={loginForm.control}
              inputClassName={inputCls}
              label="Hasło"
              name="password"
              required
            />
          </div>

          <button
            type="submit"
            disabled={loading || magicLinkLoading}
            className="w-full rounded-xl bg-teal py-3 text-sm font-semibold text-void transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {loading ? 'Logowanie...' : 'Zaloguj się'}
          </button>

          <div className="space-y-2 text-center">
            <button
              type="button"
              disabled={loading || magicLinkLoading || codeLoading}
              onClick={handleMagicLinkRequest}
              className="w-full rounded-xl border border-teal/30 bg-white py-3 text-sm font-semibold text-teal transition-colors hover:bg-teal/5 disabled:opacity-50"
            >
              {magicLinkLoading ? 'Wysyłanie...' : 'Wyślij link logowania'}
            </button>
            <p className="text-xs text-text-muted">
              {magicLinkMessage || 'Jeśli ten adres ma dostęp, wyślemy link.'}
            </p>
          </div>

          {magicLinkSentTo && (
            <div className="space-y-2 border-t border-warm-sand pt-4">
              <label htmlFor="admin-otp-code" className="block text-sm font-semibold text-text-muted">
                Kod z e-maila
              </label>
              <input
                id="admin-otp-code"
                name="otp-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder="np. 77323522"
                value={code}
                onChange={(event) => {
                  setCode(event.target.value);
                  if (codeError) setCodeError('');
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void handleCodeSubmit();
                  }
                }}
                className={inputCls}
              />
              {codeError && <p className="text-xs text-warm-coral">{codeError}</p>}
              <button
                type="button"
                disabled={loading || magicLinkLoading || codeLoading}
                onClick={() => void handleCodeSubmit()}
                className="w-full rounded-xl bg-teal py-3 text-sm font-semibold text-void transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {codeLoading ? 'Weryfikacja...' : 'Zaloguj kodem'}
              </button>
            </div>
          )}
        </form>
      </Form>
    </div>
  );
}
