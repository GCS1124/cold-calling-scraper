import { ArrowRight, Clock3, Sparkles } from 'lucide-react';
import { Link } from 'react-router-dom';

import { AuthPanel } from '../components/auth/auth-panel';
import { useAuth } from '../hooks/use-auth';

export function AuthPage() {
  const auth = useAuth();

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-5xl flex-col gap-8 px-4 py-8 md:px-8 md:py-12">
      <section className="rounded-[32px] border border-slate-200 bg-white/90 p-6 shadow-[0_24px_80px_rgba(15,23,42,0.08)] md:p-8">
        <p className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-4 py-2 text-xs font-semibold uppercase tracking-[0.24em] text-blue-700">
          <Sparkles className="h-3.5 w-3.5" />
          Account
        </p>

        <div className="mt-5 flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div className="max-w-2xl">
            <h1 className="text-[clamp(2.25rem,5vw,4rem)] font-extrabold tracking-[-0.06em] text-slate-950">
              Sign in, create an account, and keep earlier searches saved.
            </h1>
            <p className="mt-4 max-w-xl text-base leading-7 text-slate-600 md:text-lg">
              Login lives here. Search lives on the main page. History stays attached to your
              account when Supabase is configured, and falls back to local history when it is not.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Link
              className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:text-blue-700"
              to="/history"
            >
              <Clock3 className="h-4 w-4" />
              History
            </Link>
            <Link
              className="inline-flex h-11 items-center gap-2 rounded-2xl border border-slate-200 px-4 text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:text-blue-700"
              to="/search"
            >
              Go to search
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        <div className="mt-8 grid gap-4 lg:grid-cols-[1fr_0.9fr]">
          <AuthPanel auth={auth} />
        </div>
      </section>
    </main>
  );
}
