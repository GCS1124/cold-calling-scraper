import { LogIn, LogOut, Sparkles } from 'lucide-react';
import type { FormEvent } from 'react';
import { useState } from 'react';
import { toast } from 'sonner';

import type { AuthApi } from '../../hooks/use-auth';

type AuthPanelProps = {
  auth: AuthApi;
};

export function AuthPanel({ auth }: AuthPanelProps) {
  const [mode, setMode] = useState<'sign-in' | 'sign-up'>('sign-in');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);

    try {
      const message =
        mode === 'sign-in'
          ? await auth.signIn(email.trim(), password)
          : await auth.signUp(email.trim(), password);
      toast.success(message || (mode === 'sign-in' ? 'Signed in.' : 'Account created.'));
      setPassword('');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Authentication failed');
    } finally {
      setBusy(false);
    }
  };

  if (!auth.isConfigured) {
    return (
      <div className="rounded-[24px] border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
        Supabase auth is not configured. Add the Marketplace `SUPABASE_URL` and
        `SUPABASE_ANON_KEY` env vars to enable sign in and search history.
      </div>
    );
  }

  if (auth.user) {
    return (
      <div className="rounded-[24px] border border-slate-200 bg-white/90 p-4 shadow-[0_18px_60px_rgba(15,23,42,0.08)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="inline-flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              <Sparkles className="h-3.5 w-3.5" />
              Account
            </p>
            <p className="mt-2 text-sm font-semibold text-slate-950">{auth.user.email}</p>
            <p className="mt-1 text-sm text-slate-600">Earlier searches are saved to this account.</p>
          </div>

          <button
            className="inline-flex w-30 h-10 items-center gap-2 rounded-2xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:border-slate-300 hover:text-slate-950"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await auth.signOut();
                toast.success('Signed out');
              } catch (error) {
                toast.error(error instanceof Error ? error.message : 'Sign out failed');
              } finally {
                setBusy(false);
              }
            }}
            type="button"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="rounded-[24px] border border-slate-200 bg-white/90 p-4 shadow-[0_18px_60px_rgba(15,23,42,0.08)]"
      onSubmit={submit}
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
            Account
          </p>
          <h3 className="mt-2 text-base font-semibold text-slate-950">
            {mode === 'sign-in' ? 'Sign in' : 'Create account'}
          </h3>
          <p className="mt-1 text-sm text-slate-600">
            {mode === 'sign-in'
              ? 'Use Supabase to save earlier searches per account.'
              : 'Create an account to sync search history across sessions.'}
          </p>
        </div>

        <button
          className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 transition hover:border-blue-200 hover:text-blue-700"
          onClick={() => setMode(mode === 'sign-in' ? 'sign-up' : 'sign-in')}
          type="button"
        >
          {mode === 'sign-in' ? 'Need signup?' : 'Have an account?'}
        </button>
      </div>

      <div className="mt-4 grid gap-3">
        <label className="grid gap-2 text-sm font-semibold text-slate-900">
          Email
          <input
            className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none transition focus:border-blue-500"
            onChange={(event) => setEmail(event.target.value)}
            type="email"
            value={email}
          />
        </label>

        <label className="grid gap-2 text-sm font-semibold text-slate-900">
          Password
          <input
            className="h-11 rounded-2xl border border-slate-200 bg-white px-4 text-sm outline-none transition focus:border-blue-500"
            onChange={(event) => setPassword(event.target.value)}
            type="password"
            value={password}
          />
        </label>
      </div>

      <button
        className="mt-4 inline-flex h-11 items-center justify-center gap-2 rounded-2xl bg-slate-950 px-4 text-sm font-semibold text-white transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:bg-slate-400"
        disabled={busy || !email.trim() || !password}
        type="submit"
      >
        <LogIn className="h-4 w-4" />
        {busy ? 'Working...' : mode === 'sign-in' ? 'Sign in' : 'Sign up'}
      </button>
    </form>
  );
}
