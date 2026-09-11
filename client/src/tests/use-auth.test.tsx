import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const mockAuth = vi.hoisted(() => ({
  getSession: vi.fn(),
  onAuthStateChange: vi.fn(),
  unsubscribe: vi.fn(),
}));

vi.mock('../lib/supabase', () => ({
  getSupabaseClient: () => ({ auth: mockAuth }),
  isSupabaseConfigured: true,
}));

import { useAuth } from '../hooks/use-auth';

describe('useAuth', () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it('clears the loading state when the initial session lookup fails', async () => {
    mockAuth.getSession.mockRejectedValueOnce(new Error('temporary auth outage'));
    mockAuth.onAuthStateChange.mockReturnValue({
      data: { subscription: { unsubscribe: mockAuth.unsubscribe } },
    });

    const { result, unmount } = renderHook(() => useAuth());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.user).toBeNull();
    expect(result.current.session).toBeNull();
    unmount();
    expect(mockAuth.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
