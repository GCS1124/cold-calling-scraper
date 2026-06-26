import { LogIn, LogOut } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { toast } from 'sonner';

import type { AuthApi } from '../../hooks/use-auth';

type SessionActionProps = {
  auth: AuthApi;
};

export function SessionAction({ auth }: SessionActionProps) {
  const navigate = useNavigate();
  const [busy, setBusy] = useState(false);
  const [pendingRedirect, setPendingRedirect] = useState(false);

  useEffect(() => {
    if (!pendingRedirect || auth.user) {
      return;
    }

    navigate('/', { replace: true });
    setBusy(false);
    setPendingRedirect(false);
  }, [auth.user, navigate, pendingRedirect]);

  const handleSignOut = async () => {
    setBusy(true);

    try {
      await auth.signOut();
      toast.success('Signed out');
      setPendingRedirect(true);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Sign out failed');
      setBusy(false);
    }
  };

  if (auth.user) {
    return (
      <button
        className="inline-flex h-10 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3 text-sm font-semibold text-slate-700 shadow-sm backdrop-blur transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
        disabled={busy}
        onClick={handleSignOut}
        type="button"
      >
        <LogOut className="h-4 w-4" />
        <span className="hidden sm:inline">Sign out</span>
      </button>
    );
  }

  return (
    <Link
      className="inline-flex h-10 items-center gap-2 rounded-2xl border border-slate-200 bg-white/80 px-3 text-sm font-semibold text-slate-700 shadow-sm backdrop-blur transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
      to="/"
    >
      <LogIn className="h-4 w-4" />
      <span className="hidden sm:inline">Sign in</span>
    </Link>
  );
}
