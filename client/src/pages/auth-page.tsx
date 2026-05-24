import {
  ArrowRight,
  Clock3,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { AuthPanel } from '../components/auth/auth-panel';
import { useAuth } from '../hooks/use-auth';

export function AuthPage() {
  const auth = useAuth();

  return (
    <main className="relative min-h-screen overflow-hidden bg-slate-50 px-4 py-6 text-slate-950 sm:px-6 lg:px-8">
      <div className="pointer-events-none absolute inset-0">
        <div className="absolute -left-32 top-[-10rem] h-80 w-80 rounded-full bg-blue-200/50 blur-3xl" />
        <div className="absolute right-[-8rem] top-24 h-96 w-96 rounded-full bg-indigo-200/50 blur-3xl" />
        <div className="absolute bottom-[-12rem] left-1/2 h-96 w-96 -translate-x-1/2 rounded-full bg-cyan-100 blur-3xl" />
      </div>

      <section className="relative mx-auto grid min-h-[calc(100vh-3rem)] w-full max-w-6xl overflow-hidden rounded-[2rem] border border-white/70 bg-white/80 shadow-[0_30px_100px_rgba(15,23,42,0.14)] backdrop-blur-xl lg:grid-cols-[1.05fr_0.95fr]">
        
        {/* Left Panel */}
        <div className="relative hidden flex-col overflow-hidden bg-slate-950 p-10 text-white lg:flex">
          <div className="pointer-events-none absolute inset-0">
            <div className="absolute -right-24 -top-24 h-72 w-72 rounded-full bg-blue-500/30 blur-3xl" />
            <div className="absolute bottom-[-8rem] left-[-6rem] h-80 w-80 rounded-full bg-cyan-400/20 blur-3xl" />

            <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_right,rgba(96,165,250,0.18),transparent_35%),linear-gradient(rgba(255,255,255,0.04)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.04)_1px,transparent_1px)] bg-[size:auto,36px_36px,36px_36px]" />
          </div>

          <div className="relative">
            <p className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/10 px-4 py-2 text-xs font-semibold uppercase tracking-[0.22em] text-blue-100">
              <Sparkles className="h-3.5 w-3.5" />
              Account access
            </p>

            <h1 className="mt-8 max-w-xl text-5xl font-black leading-[0.95] tracking-[-0.055em] xl:text-6xl">
              Your searches, saved exactly where you left them.
            </h1>

            <p className="mt-6 max-w-lg text-base leading-7 text-slate-300">
              Create an account to sync search history with Supabase. When cloud auth is not
              configured, the app continues using local history on this device.
            </p>
          </div>

          {/* Reduced spacing here */}
          <div className="relative mt-36 flex items-center justify-between rounded-3xl border border-white/10 bg-white/[0.06] p-4 xl:mt-44">
            <div>
              <p className="text-sm font-semibold text-white">
                Ready to search?
              </p>

              <p className="mt-1 text-sm text-slate-400">
                Jump back into the main workspace.
              </p>
            </div>

            <Link
              className="inline-flex h-11 items-center gap-2 rounded-2xl bg-blue-600 px-4 text-sm font-bold text-white transition hover:bg-blue-700"
              to="/search"
            >
              Search
              <ArrowRight className="h-4 w-4" />
            </Link>
          </div>
        </div>

        {/* Right Panel */}
        <div className="flex min-h-full flex-col bg-white">
          <header className="flex items-center justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-8">
            <Link
              className="inline-flex items-center gap-2 text-sm font-black tracking-tight text-slate-950"
              to="/search"
            >
              <span className="flex h-9 w-9 items-center justify-center rounded-2xl bg-slate-950 text-white">
                <Sparkles className="h-4 w-4" />
              </span>

              Cold Calling Scraper
            </Link>

            <div className="flex items-center gap-2">
              <Link
                className="inline-flex h-10 items-center gap-2 rounded-2xl border border-slate-200 px-3 text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                to="/history"
              >
                <Clock3 className="h-4 w-4" />
                <span className="hidden sm:inline">History</span>
              </Link>

              <Link
                className="inline-flex h-10 items-center gap-2 rounded-2xl border border-slate-200 px-3 text-sm font-semibold text-slate-700 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
                to="/search"
              >
                Search
                <ArrowRight className="h-4 w-4" />
              </Link>
            </div>
          </header>

          <div className="flex flex-1 items-center justify-center px-5 py-10 sm:px-8">
            <div className="w-full max-w-md">
              
              {/* Mobile Hero */}
              <div className="mb-8 lg:hidden">
                <p className="inline-flex items-center gap-2 rounded-full border border-blue-100 bg-blue-50 px-4 py-2 text-xs font-bold uppercase tracking-[0.2em] text-blue-700">
                  <Sparkles className="h-3.5 w-3.5" />
                  Account access
                </p>

                <h1 className="mt-5 text-4xl font-black leading-tight tracking-[-0.05em] text-slate-950 sm:text-5xl">
                  Save your searches.
                </h1>

                <p className="mt-4 text-base leading-7 text-slate-600">
                  Sign in to keep your search history synced, or continue with local history when
                  Supabase is not configured.
                </p>
              </div>

              {/* Auth Card */}
              <div className="rounded-[1.75rem] border border-slate-200 bg-white p-5 shadow-[0_20px_70px_rgba(15,23,42,0.10)] sm:p-6">
                <div className="mb-6">
                  <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-blue-50 text-blue-700">
                    <ShieldCheck className="h-6 w-6" />
                  </div>

                  <h2 className="mt-4 text-2xl font-black tracking-[-0.035em] text-slate-950">
                    Welcome back
                  </h2>

                  <p className="mt-2 text-sm leading-6 text-slate-500">
                    Sign in or create an account to manage saved searches and history.
                  </p>
                </div>

                <AuthPanel auth={auth} />
              </div>

              <p className="mt-5 text-center text-xs leading-5 text-slate-500">
                Your search history is attached to your account when cloud auth is enabled.
              </p>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}