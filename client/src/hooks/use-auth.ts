import { useEffect, useState } from 'react';
import type { Session, User } from '@supabase/supabase-js';

import { getSupabaseClient, isSupabaseConfigured } from '../lib/supabase';

export type AuthApi = {
  user: User | null;
  session: Session | null;
  loading: boolean;
  isConfigured: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<string>;
  signOut: () => Promise<void>;
};

export const useAuth = (): AuthApi => {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(isSupabaseConfigured);

  useEffect(() => {
    const supabase = getSupabaseClient();

    if (!supabase) {
      setLoading(false);
      return;
    }

    let active = true;

    void supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session);
        setLoading(false);
      }
    });

    const { data } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setLoading(false);
    });

    return () => {
      active = false;
      data.subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    const supabase = getSupabaseClient();

    if (!supabase) {
      throw new Error('Supabase auth is not configured');
    }

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) {
      throw error;
    }
  };

  const signUp = async (email: string, password: string) => {
    const supabase = getSupabaseClient();

    if (!supabase) {
      throw new Error('Supabase auth is not configured');
    }

    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: {
        emailRedirectTo: window.location.origin,
      },
    });

    if (error) {
      throw error;
    }

    return data.session ? 'Signed up and signed in.' : 'Check your email to confirm your account.';
  };

  const signOut = async () => {
    const supabase = getSupabaseClient();

    if (!supabase) {
      return;
    }

    const { error } = await supabase.auth.signOut();

    if (error) {
      throw error;
    }
  };

  return {
    user: session?.user ?? null,
    session,
    loading,
    isConfigured: isSupabaseConfigured,
    signIn,
    signUp,
    signOut,
  };
};
