import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockAuthState = vi.hoisted(() => ({
  user: null as { id: string; email: string } | null,
  session: null as { user: { id: string; email: string } } | null,
  loading: false,
  isConfigured: true,
  signIn: vi.fn(),
  signUp: vi.fn(),
  signOut: vi.fn(),
}));

vi.mock('framer-motion', () => ({
  motion: new Proxy(
    {},
    {
      get: () =>
        function MotionPassthrough({
          children,
          ...props
        }: {
          children?: unknown;
          [key: string]: unknown;
        }) {
          return <div {...props}>{children as ReactNode}</div>;
        },
    },
  ),
}));

vi.mock('sonner', () => ({
  Toaster: () => null,
  toast: {
    error: () => {},
    success: () => {},
  },
}));

vi.mock('../hooks/use-auth', () => ({
  useAuth: () => mockAuthState,
}));

vi.mock('../hooks/use-search-history', () => ({
  useSearchHistory: () => ({
    rememberSearch: vi.fn(),
  }),
  useSearchHistoryDetails: () => ({
    items: [],
  }),
}));

import App from '../App';
import type { SearchApi } from '../services/search-service';

const cleanupTasks: Array<() => Promise<void>> = [];

beforeEach(() => {
  mockAuthState.user = null;
  mockAuthState.session = null;
  mockAuthState.loading = false;
  mockAuthState.isConfigured = true;
  mockAuthState.signIn.mockReset();
  mockAuthState.signUp.mockReset();
  mockAuthState.signOut.mockReset();
  mockAuthState.signOut.mockImplementation(async () => {
    mockAuthState.user = null;
    mockAuthState.session = null;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();

  while (cleanupTasks.length) {
    const cleanup = cleanupTasks.pop();
    if (cleanup) {
      await cleanup();
    }
  }

  document.body.innerHTML = '';
});

type RenderedApp = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
};

async function renderApp(initialEntries: string[], searchApi: SearchApi): Promise<RenderedApp> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  let cleanedUp = false;

  root.render(
    <MemoryRouter initialEntries={initialEntries}>
      <App searchApi={searchApi} />
    </MemoryRouter>,
  );

  await new Promise((resolve) => setTimeout(resolve, 0));

  const unmount = async () => {
    if (cleanedUp) {
      return;
    }

    cleanedUp = true;

    root.unmount();
    container.remove();
  };

  cleanupTasks.push(unmount);

  return { container, root, unmount };
}

function normalizedText(node: Element | DocumentFragment | null) {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim();
}

async function waitForText(container: Element, pattern: RegExp, timeoutMs = 3000) {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (pattern.test(normalizedText(container))) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out waiting for ${pattern.toString()}`);
}

function getButton(container: Element, name: RegExp) {
  const button = Array.from(container.querySelectorAll('button')).find((element) =>
    name.test(normalizedText(element)),
  );

  if (!button) {
    throw new Error(`Could not find button ${name.toString()}`);
  }

  return button as HTMLButtonElement;
}

async function clickElement(element: Element) {
  if (element instanceof HTMLElement) {
    element.click();
  } else {
    element.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  }

  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('session navigation', () => {
  it('redirects authenticated users away from the auth page and into search', async () => {
    mockAuthState.user = { id: 'user-1', email: 'agent@example.com' };
    mockAuthState.session = { user: mockAuthState.user };

    const searchApi: SearchApi = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };

    const { container, unmount } = await renderApp(['/'], searchApi);

    await waitForText(container, /build your lead list/i);
    expect(normalizedText(container)).toContain('Sign out');
    expect(normalizedText(container)).not.toContain('Welcome back');

    await unmount();
  });

  it('shows sign out in the header and returns to auth after signing out', async () => {
    mockAuthState.user = { id: 'user-1', email: 'agent@example.com' };
    mockAuthState.session = { user: mockAuthState.user };

    const searchApi: SearchApi = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await waitForText(container, /sign out/i);
    await clickElement(getButton(container, /sign out/i));

    expect(mockAuthState.signOut).toHaveBeenCalledTimes(1);
    await waitForText(container, /welcome back/i);
    expect(normalizedText(container)).toContain('Account access');
    expect(normalizedText(container)).not.toContain('Sign out');

    await unmount();
  });
});
