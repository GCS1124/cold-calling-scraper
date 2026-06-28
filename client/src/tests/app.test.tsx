import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

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

import App from '../App';
import type { SearchApi } from '../services/search-service';
import { rememberSearchHistory } from '../services/search-history-service';
import type { SearchResponse } from '../types/lead';

const completedResponse: SearchResponse = {
  searchId: 'search-1',
  leads: [
    {
      id: 'lead-1',
      name: 'Northstar Labs',
      mobile: '+1 512 555 0121',
      email: 'hello@northstarlabs.ai',
      website: 'https://northstarlabs.ai',
      address: 'South Congress',
      category: 'Dental Clinics',
      city: 'Austin, TX',
      source: 'OpenStreetMap',
      confidence: 92,
      sourceScore: 80,
      hasEmail: true,
      hasPhone: true,
      hasWebsite: true,
      verifiedPhone: true,
      verifiedEmail: true,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    },
    {
      id: 'lead-2',
      name: 'Orbit Data Works',
      mobile: '+1 512 555 0146',
      email: '',
      website: 'https://orbitdataworks.com',
      address: '',
      category: 'Dental Clinics',
      city: 'Austin, TX',
      source: 'OpenStreetMap',
      confidence: 74,
      sourceScore: 65,
      rejectionReason: 'missing_email',
      hasEmail: false,
      hasPhone: true,
      hasWebsite: true,
      verifiedPhone: true,
      verifiedEmail: false,
      scrapedAt: '2026-04-21T00:00:00.000Z',
    },
  ],
  meta: {
    query: 'Dental Clinics in Eastern Time',
    locationLabel: 'Eastern Time',
    status: 'complete',
    progress: {
      discovered: 2,
      enriched: 2,
      totalCandidates: 2,
      requestedCount: 50,
      foundCount: 2,
      duplicatesRemoved: 0,
      currentSource: 'Complete',
      batchesCompleted: 2,
      estimatedRemaining: 49,
    },
    totals: {
      total: 2,
      withEmail: 1,
      withPhone: 2,
      withWebsite: 2,
    },
    providerWarnings: [],
  },
};

const cityStateResponse: SearchResponse = {
  ...completedResponse,
  meta: {
    ...completedResponse.meta,
    query: 'Dental Clinics in Austin, TX',
    locationLabel: 'Austin, TX',
  },
};

const waitingResponse: SearchResponse = {
  searchId: 'search-waiting',
  leads: [],
  meta: {
    query: 'Dental Clinics in Eastern Time',
    locationLabel: 'Eastern Time',
    status: 'discovering',
    progress: {
      discovered: 18,
      enriched: 0,
      totalCandidates: 18,
      requestedCount: 50,
      foundCount: 18,
      duplicatesRemoved: 0,
      currentSource: 'Google Places',
      batchesCompleted: 1,
      estimatedRemaining: 32,
    },
    totals: {
      total: 0,
      withEmail: 0,
      withPhone: 0,
      withWebsite: 0,
    },
    providerWarnings: [],
  },
};

const queuedResponse: SearchResponse = {
  ...waitingResponse,
  searchId: 'search-queued',
  meta: {
    ...waitingResponse.meta,
    status: 'queued',
    progress: {
      ...waitingResponse.meta.progress,
      discovered: 0,
      enriched: 0,
      totalCandidates: 0,
      foundCount: 0,
      currentSource: 'Queued',
      batchesCompleted: 0,
      estimatedRemaining: 50,
    },
  },
};

const cleanupTasks: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.restoreAllMocks();

  while (cleanupTasks.length) {
    const cleanup = cleanupTasks.pop();
    if (cleanup) {
      await cleanup();
    }
  }

  window.localStorage.clear();
  document.body.innerHTML = '';
});

type RenderedApp = {
  container: HTMLDivElement;
  root: Root;
  unmount: () => Promise<void>;
};

async function renderApp(
  initialEntries: string[],
  searchApi: SearchApi,
): Promise<RenderedApp> {
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

function getSelectByOptionValue(container: Element, optionValue: string) {
  const select = Array.from(container.querySelectorAll('select')).find((element) =>
    Array.from(element.options).some((option) => option.value === optionValue),
  );

  if (!select) {
    throw new Error(`Could not find select containing option value "${optionValue}"`);
  }

  return select as HTMLSelectElement;
}

function getCompanyTypeInput(container: Element) {
  const input = container.querySelector('input[list="company-type-options"]');
  if (!input) {
    throw new Error('Could not find company type input');
  }

  return input as HTMLInputElement;
}

function getCityInput(container: Element) {
  const input = container.querySelector('input[placeholder="Austin, Phoenix, Miami"]');
  if (!input) {
    throw new Error('Could not find city input');
  }

  return input as HTMLInputElement;
}

async function typeValue(input: HTMLInputElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    'value',
  );

  descriptor?.set?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function selectValue(select: HTMLSelectElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(select),
    'value',
  );

  descriptor?.set?.call(select, value);
  select.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  select.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  await new Promise((resolve) => setTimeout(resolve, 50));
}

async function clickElement(element: Element) {
  if (element instanceof HTMLElement) {
    element.click();
  } else {
    element.dispatchEvent(new Event('click', { bubbles: true, cancelable: true }));
  }
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe('App', () => {
  it('shows the auth landing page at the base path', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };

    const { container, unmount } = await renderApp(['/' ], searchApi);

    await waitForText(container, /your searches, saved exactly where you left them/i);
    expect(Array.from(container.querySelectorAll('a')).filter((link) => /^search$/i.test(normalizedText(link))).length).toBeGreaterThan(0);

    await unmount();
  });

  it('shows strict location controls and preserves values when switching modes on the search route', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    const companyTypeInput = getCompanyTypeInput(container);
    const timeZoneSelect = getSelectByOptionValue(container, 'EST');

    expect(companyTypeInput.getAttribute('list')).toBe('company-type-options');
    expect(Array.from(timeZoneSelect.querySelectorAll('option')).map((option) => option.value)).toEqual([
      '',
      'EST',
      'CST',
      'MST',
      'PST',
    ]);
    expect(container.querySelector('input[placeholder="Austin, Phoenix, Miami"]')).toBeNull();
    expect(container.querySelector('select option[value="TX"]')).toBeNull();

    await selectValue(timeZoneSelect, 'EST');
    await clickElement(getButton(container, /city \/ state/i));

    const cityInput = getCityInput(container);
    const stateSelect = getSelectByOptionValue(container, 'TX');

    await typeValue(cityInput, 'Austin');
    await selectValue(stateSelect, 'TX');

    await clickElement(getButton(container, /time zone/i));
    expect(getSelectByOptionValue(container, 'EST').value).toBe('EST');

    await clickElement(getButton(container, /city \/ state/i));
    expect(getCityInput(container).value).toBe('Austin');

    await unmount();
  });

  it('submits a search and renders leads found by default', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(completedResponse),
      getSearch: vi.fn().mockResolvedValue(completedResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await typeValue(getCompanyTypeInput(container), 'Dental Clinics');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    expect(searchApi.startSearch).toHaveBeenCalledWith({
      companyType: 'Dental Clinics',
      location: {
        mode: 'timezone',
        timeZone: 'EST',
      },
      count: 50,
    });

    await waitForText(container, /discovery complete/i, 6000);
    expect(normalizedText(container)).toContain('2 visible leads');
    expect(normalizedText(container)).toContain('Eastern Time');
    expect(normalizedText(container)).toContain('Discovery complete');

    await unmount();
  });

  it('submits a city and state search with the structured location payload', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(cityStateResponse),
      getSearch: vi.fn().mockResolvedValue(cityStateResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await typeValue(getCompanyTypeInput(container), 'Dental Clinics');
    await clickElement(getButton(container, /city \/ state/i));
    await typeValue(getCityInput(container), 'Austin');
    await selectValue(getSelectByOptionValue(container, 'TX'), 'TX');
    await clickElement(getButton(container, /find leads/i));

    expect(searchApi.startSearch).toHaveBeenCalledWith({
      companyType: 'Dental Clinics',
      location: {
        mode: 'cityState',
        city: 'Austin',
        stateCode: 'TX',
      },
      count: 50,
    });

    await waitForText(container, /discovery complete/i, 6000);
    expect(normalizedText(container)).toContain('Austin, TX');
    expect(normalizedText(container)).toContain('Discovery complete');

    await unmount();
  });

  it('renders a simple leads found status without warning clutter', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(completedResponse),
      getSearch: vi.fn().mockResolvedValue(completedResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await typeValue(getCompanyTypeInput(container), 'Dental Clinics');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    await waitForText(container, /discovery complete/i, 6000);
    expect(normalizedText(container)).toContain('Missing Phone');
    expect(normalizedText(container)).not.toContain('show rejected leads');
    expect(normalizedText(container)).not.toContain('include partial leads');
    expect(normalizedText(container)).toContain('Download Excel');

    await unmount();
  });

  it('shows a waiting screen while the job is still running', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(waitingResponse),
      getSearch: vi.fn().mockResolvedValue(waitingResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await typeValue(getCompanyTypeInput(container), 'Dental Clinics');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    await waitForText(container, /finding your leads/i, 10000);
    expect(normalizedText(container)).toContain('Results will appear here when the search finishes');
    expect(normalizedText(container)).not.toContain('click any company row to verify details before export');
    expect(normalizedText(container)).not.toContain('Download Excel');

    await unmount();
  });

  it('keeps polling when discovery responses do not change yet', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(queuedResponse),
      getSearch: vi
        .fn()
        .mockResolvedValueOnce(waitingResponse)
        .mockResolvedValueOnce(waitingResponse)
        .mockResolvedValue(completedResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await typeValue(getCompanyTypeInput(container), 'Dental Clinics');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    await waitForText(container, /discovery complete/i, 10000);
    expect(searchApi.getSearch).toHaveBeenCalledTimes(3);
    expect(normalizedText(container)).toContain('Discovery complete');

    await unmount();
  });

  it('shows the history page with downloadable saved searches', async () => {
    await rememberSearchHistory(
      {
        companyType: 'Dental Clinics',
        location: {
          mode: 'cityState',
          city: 'Austin',
          stateCode: 'TX',
        },
        count: 50,
      },
      {
        leads: [
          {
            id: 'lead-1',
            name: 'Northstar Labs',
            mobile: '+1 512 555 0121',
            email: 'hello@northstarlabs.ai',
            website: 'https://northstarlabs.ai',
            address: 'South Congress',
            category: 'Dental Clinics',
            city: 'Austin, TX',
            source: 'OpenStreetMap',
            confidence: 92,
            hasEmail: true,
            hasPhone: true,
            hasWebsite: true,
            verifiedPhone: true,
            verifiedEmail: true,
            scrapedAt: '2026-04-21T00:00:00.000Z',
          },
        ] as never,
      },
    );

    const { container, unmount } = await renderApp(['/history'], {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    });

    await waitForText(container, /Dental Clinics/i);
    expect(normalizedText(container)).toContain('Dental Clinics');
    expect(normalizedText(container)).toContain('Austin, TX');
    expect(normalizedText(container)).toContain('Ready');
    expect(normalizedText(container)).toContain('1 lead saved');
    expect(Array.from(container.querySelectorAll('button')).some((button) => /export/i.test(normalizedText(button)))).toBe(true);

    await unmount();
  });
});
