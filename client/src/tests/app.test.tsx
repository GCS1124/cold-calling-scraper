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

const streamingResponse: SearchResponse = {
  ...completedResponse,
  searchId: 'search-streaming',
  meta: {
    ...completedResponse.meta,
    status: 'enriching',
    progress: {
      ...completedResponse.meta.progress,
      currentSource: 'Public Contact Enrichment',
      discovered: 2,
      enriched: 1,
      batchesCompleted: 1,
      estimatedRemaining: 48,
    },
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

const blockedLinkedinResponse: SearchResponse = {
  ...completedResponse,
  searchId: 'search-linkedin-blocked',
  leads: [],
  meta: {
    ...completedResponse.meta,
    query: 'Dentist in Eastern Time',
    progress: {
      ...completedResponse.meta.progress,
      discovered: 0,
      enriched: 0,
      totalCandidates: 0,
      foundCount: 0,
      batchesCompleted: 0,
      estimatedRemaining: 50,
    },
    totals: {
      total: 0,
      withEmail: 0,
      withPhone: 0,
      withWebsite: 0,
    },
    providerWarnings: [
      {
        providerId: 'linkedin-search-brave',
        providerName: 'Brave Search',
        message: 'Brave Search was paused after repeated failures (2/2 attempts).',
      },
      {
        providerId: 'linkedin-search',
        providerName: 'LinkedIn',
        message:
          'LinkedIn search providers were blocked or rate-limited, so no public profiles were returned.',
      },
    ],
  },
};

const emptyLinkedinResponse: SearchResponse = {
  ...blockedLinkedinResponse,
  searchId: 'search-linkedin-empty',
  meta: {
    ...blockedLinkedinResponse.meta,
    providerWarnings: [],
  },
};

const aiModeResponse: SearchResponse = {
  ...completedResponse,
  searchId: 'search-ai-mode',
  meta: {
    ...completedResponse.meta,
    query: 'Dentist in Eastern Time',
    progress: {
      ...completedResponse.meta.progress,
      providerCoverage: [
        {
          providerId: 'apollo-audit',
          providerName: 'Apollo',
          status: 'not_configured',
          leadCount: 0,
          message: 'Not used in free mode.',
        },
        {
          providerId: 'linkedin-public-search',
          providerName: 'Public LinkedIn Search',
          status: 'returned',
          leadCount: 2,
        },
      ],
      aiAssistance: 'disabled',
      publicQueriesAttempted: 16,
      publicProvidersChecked: 3,
    },
    providerWarnings: [
      {
        providerId: 'ai-mode-policy',
        providerName: 'AI mode',
        message: 'Free AI mode does not use paid databases.',
      },
    ],
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

  await new Promise((resolve) => setTimeout(resolve, 25));

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

function getCheckboxByLabel(container: Element, pattern: RegExp) {
  const label = Array.from(container.querySelectorAll('label')).find((element) =>
    pattern.test(normalizedText(element)),
  );
  const checkbox = label?.querySelector('input[type="checkbox"]');

  if (!checkbox) {
    throw new Error(`Could not find checkbox ${pattern.toString()}`);
  }

  return checkbox as HTMLInputElement;
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
      sourceMode: 'gmb',
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
    await waitForText(container, /Publicly validated/i, 1000);

    await unmount();
  });

  it('shows public validation labels for LinkedIn contact fields', async () => {
    const linkedinResponse: SearchResponse = {
      ...completedResponse,
      searchId: 'search-linkedin-public-contacts',
      leads: completedResponse.leads.map((lead, index) => ({
        ...lead,
        id: `linkedin-public-contact-${index}`,
        name: `Public LinkedIn ${lead.name}`,
        source: 'LinkedIn',
        listingUrl: index === 1 ? undefined : `https://www.linkedin.com/in/public-linkedin-${index}`,
        contactSourceUrl: lead.website,
        publicEvidence: {
          profileTitle: `Public LinkedIn ${lead.name} - Founder`,
          profileSnippet: 'Public profile matched the requested business category.',
        },
      })),
    };
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(linkedinResponse),
      getSearch: vi.fn().mockResolvedValue(linkedinResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await clickElement(getButton(container, /linkedin/i));
    await typeValue(getCompanyTypeInput(container), 'Dental Clinics');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    await waitForText(container, /public linkedin discovery complete/i, 6000);
    await waitForText(container, /Publicly validated/i, 1000);
    expect(normalizedText(container)).toContain('Public LinkedIn Northstar Labs');
    expect(normalizedText(container)).toContain('Profile / Website');
    expect(normalizedText(container)).toContain('Inspect public profile evidence before export.');
    expect(normalizedText(container)).toContain('LinkedIn profile');
    expect(normalizedText(container)).toContain('Business website');
    expect(
      container
        .querySelector('a[aria-label="Open LinkedIn profile for Public LinkedIn Northstar Labs"]')
        ?.getAttribute('href'),
    ).toBe('https://www.linkedin.com/in/public-linkedin-0');
    expect(
      container
        .querySelector('a[aria-label="Open business website for Public LinkedIn Orbit Data Works"]')
        ?.getAttribute('href'),
    ).toBe('https://orbitdataworks.com');
    expect(
      container.querySelector('a[aria-label="Open LinkedIn profile for Public LinkedIn Orbit Data Works"]'),
    ).toBeNull();

    await clickElement(getButton(container, /download excel/i));
    await waitForText(container, /Listing \/ profile URL/i, 1000);
    expect(normalizedText(container)).toContain('Business website');
    expect(normalizedText(container)).toContain('Contact source URL');
    expect(normalizedText(container)).toContain('Match confidence');

    await unmount();
  });

  it('renders optional provider configuration as informational notes', async () => {
    const infoResponse: SearchResponse = {
      ...completedResponse,
      searchId: 'search-provider-info',
      meta: {
        ...completedResponse.meta,
        providerWarnings: [
          {
            providerId: 'google-places',
            providerName: 'Google Places',
            message:
              'Optional Google Places is not configured. Continuing with free OpenStreetMap and public map discovery.',
            severity: 'info',
          },
        ],
      },
    };
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(infoResponse),
      getSearch: vi.fn().mockResolvedValue(infoResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await typeValue(getCompanyTypeInput(container), 'Dental Clinics');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    await waitForText(container, /provider notes/i, 6000);
    expect(normalizedText(container)).toContain('free OpenStreetMap and public map discovery');
    expect(normalizedText(container)).not.toContain('Provider notices');

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
      sourceMode: 'gmb',
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

  it('shows discovered rows while public contact enrichment is still running', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(streamingResponse),
      getSearch: vi.fn().mockResolvedValue(streamingResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await typeValue(getCompanyTypeInput(container), 'Dental Clinics');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    await waitForText(container, /live scan/i, 10000);
    await waitForText(container, /Northstar Labs/i, 1000);
    expect(normalizedText(container)).toContain('2 visible leads');
    expect(normalizedText(container)).toContain('Northstar Labs');
    expect(normalizedText(container)).toContain('Collecting contact details');
    expect(normalizedText(container)).not.toContain('Results will appear here when the search finishes');
    expect(normalizedText(container)).not.toContain('Download Excel');

    await unmount();
  });

  it('submits a LinkedIn search with the alternate source mode', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(completedResponse),
      getSearch: vi.fn().mockResolvedValue(completedResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await clickElement(getButton(container, /linkedin/i));
    expect(normalizedText(container)).toContain('Free public profiles');
    expect(normalizedText(container)).toContain('LinkedIn discovery recipe');
    expect(normalizedText(container)).toContain('Role expansion');
    expect(normalizedText(container)).toContain('Public-site enrichment');
    expect(normalizedText(container)).toContain('Live search blueprint');
    expect(normalizedText(container)).toContain('Category');
    expect(normalizedText(container)).toContain('Your business type');
    expect(normalizedText(container)).toContain('Intent');
    expect(normalizedText(container)).toContain('Decision-makers');
    await typeValue(getCompanyTypeInput(container), 'Founders');
    expect(normalizedText(container)).toContain('Founders');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    expect(searchApi.startSearch).toHaveBeenCalledWith({
      companyType: 'Founders',
      sourceMode: 'linkedin',
      location: {
        mode: 'timezone',
        timeZone: 'EST',
      },
      count: 50,
    });

    await waitForText(container, /discovery complete/i, 6000);
    expect(normalizedText(container)).toContain('LinkedIn');

    await unmount();
  });

  it('submits free AI mode and renders provider coverage honestly', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(aiModeResponse),
      getSearch: vi.fn().mockResolvedValue(aiModeResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await clickElement(getButton(container, /ai mode/i));
    expect(normalizedText(container)).toContain('Free public discovery');
    expect(normalizedText(container)).toContain('no paid databases');
    await typeValue(getCompanyTypeInput(container), 'Dentist');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    expect(searchApi.startSearch).toHaveBeenCalledWith({
      companyType: 'Dentist',
      sourceMode: 'ai',
      location: {
        mode: 'timezone',
        timeZone: 'EST',
      },
      count: 50,
    });

    await waitForText(container, /free ai mode coverage/i, 6000);
    const content = normalizedText(container);
    expect(content).toContain('No paid sources');
    expect(content).toContain('Public LinkedIn Search');
    expect(content).toContain('Apollo');
    expect(content).toContain('Not used');
    expect(content).toContain('AI query assistance is off so this mode stays free');

    await unmount();
  });

  it('clears results when switching the lead source mode', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(completedResponse),
      getSearch: vi.fn().mockResolvedValue(completedResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await typeValue(getCompanyTypeInput(container), 'Dentist');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));
    await waitForText(container, /discovery complete/i, 6000);

    await waitForText(container, /Northstar Labs/i, 6000);
    expect(normalizedText(container)).toContain('Northstar Labs');

    await clickElement(getButton(container, /linkedin/i));

    expect(normalizedText(container)).not.toContain('Northstar Labs');
    expect(normalizedText(container)).toContain('Public LinkedIn discovery');

    await unmount();
  });

  it('shows an honest blocked state and provider details when free LinkedIn discovery is unavailable', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(blockedLinkedinResponse),
      getSearch: vi.fn().mockResolvedValue(blockedLinkedinResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await clickElement(getButton(container, /linkedin/i));
    await typeValue(getCompanyTypeInput(container), 'Dentist');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    await waitForText(container, /linkedin discovery blocked/i, 6000);

    const content = normalizedText(container);
    expect(content).toContain('Provider access blocked');
    expect(content).toContain('Brave Search was paused after repeated failures');
    expect(content).toContain('No unverified or fabricated leads were added');
    expect(content).not.toContain(
      'We verified the available businesses and stopped once the discovery sources stopped returning new results',
    );

    await unmount();
  });

  it('lets users retry a completed empty LinkedIn search with the same request', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(blockedLinkedinResponse),
      getSearch: vi.fn().mockResolvedValue(blockedLinkedinResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await clickElement(getButton(container, /linkedin/i));
    await typeValue(getCompanyTypeInput(container), 'Dentist');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));
    await waitForText(container, /linkedin discovery blocked/i, 6000);

    await clickElement(getButton(container, /try public search again/i));

    expect(searchApi.startSearch).toHaveBeenCalledTimes(2);
    expect(searchApi.startSearch).toHaveBeenLastCalledWith({
      companyType: 'Dentist',
      sourceMode: 'linkedin',
      location: {
        mode: 'timezone',
        timeZone: 'EST',
      },
      count: 50,
    });

    await unmount();
  });

  it('offers a retry for an empty LinkedIn search without provider warnings', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(emptyLinkedinResponse),
      getSearch: vi.fn().mockResolvedValue(emptyLinkedinResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await clickElement(getButton(container, /linkedin/i));
    await typeValue(getCompanyTypeInput(container), 'Dentist');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));
    await waitForText(container, /discovery complete/i, 6000);

    await clickElement(getButton(container, /try public search again/i));
    expect(searchApi.startSearch).toHaveBeenCalledTimes(2);

    await unmount();
  });

  it('lets users resume polling after a transient status update failure', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(waitingResponse),
      getSearch: vi
        .fn()
        .mockRejectedValueOnce(new Error('The search service is temporarily unavailable.'))
        .mockResolvedValueOnce(completedResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await typeValue(getCompanyTypeInput(container), 'Dentist');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));
    await waitForText(container, /status update paused/i, 6000);

    await clickElement(getButton(container, /retry status check/i));
    await waitForText(container, /discovery complete/i, 6000);
    expect(searchApi.getSearch).toHaveBeenCalledTimes(2);

    await unmount();
  });

  it('reports missing contact coverage from LinkedIn lead fields', async () => {
    const linkedinResponse: SearchResponse = {
      ...completedResponse,
      searchId: 'search-linkedin-contacts',
      leads: [
        {
          ...completedResponse.leads[0],
          name: 'Public LinkedIn Dentist',
          mobile: '',
          email: '',
          website: '',
          contactSourceUrl: 'https://austindentalspa.example/contact',
          publicEvidence: {
            profileTitle: 'Public LinkedIn Dentist - Founder at Austin Dental Spa',
            profileSnippet: 'Dentist and practice owner in Austin, Texas.',
            sources: [
              {
                providerName: 'Brave Search',
                profileTitle: 'Public LinkedIn Dentist - Founder at Austin Dental Spa',
                profileSnippet: 'Dentist and practice owner in Austin, Texas.',
              },
              {
                providerName: 'Bing',
                profileTitle: 'Public LinkedIn Dentist - Founder at Austin Dental Spa',
                profileSnippet: 'Owner at Austin Dental Spa.',
              },
            ],
          },
          source: 'LinkedIn',
          listingUrl: 'https://linkedin.com/in/public-linkedin-dentist',
          matchSignals: {
            queryMatches: 3,
            publicSources: 2,
            publicProviderNames: ['Brave Search', 'Bing'],
            categoryMatchedTerms: ['Dentist', 'dental clinic'],
            roleMatchedTerms: ['Founder', 'owner'],
            locationEvidence: 'Austin, TX',
            categoryMatched: true,
            roleMatched: true,
            locationMatched: true,
          },
          hasEmail: false,
          hasPhone: false,
          hasWebsite: false,
          verifiedPhone: false,
          verifiedEmail: false,
          rejectionReason: 'missing_contact',
        },
      ],
      meta: {
        ...completedResponse.meta,
        progress: {
          ...completedResponse.meta.progress,
          discovered: 1,
          enriched: 1,
          publicContactsFound: 0,
          publicQueriesAttempted: 12,
          publicProvidersChecked: 3,
          totalCandidates: 1,
          foundCount: 1,
          estimatedRemaining: 49,
        },
        totals: {
          total: 1,
          withEmail: 0,
          withPhone: 0,
          withWebsite: 0,
        },
      },
    };
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(linkedinResponse),
      getSearch: vi.fn().mockResolvedValue(linkedinResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await clickElement(getButton(container, /linkedin/i));
    await typeValue(getCompanyTypeInput(container), 'Dentist');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));

    await waitForText(container, /discovery complete/i, 6000);
    await waitForText(container, /Public match/i, 1000);
    const content = normalizedText(container);
    expect(content).toContain('Public contact coverage');
    expect(content).toContain('Public search coverage');
    expect(content).toContain('12 query paths');
    expect(content).toContain('3 public search sources');
    expect(content).toContain('Public match');
    expect(content).toContain('Role signal');
    expect(content).toContain('Location signal');
    expect(content).toContain('3 query paths');
    expect(content).toContain('Match intelligence');
    expect(content).toContain('Cross-source');
    expect(content).toContain('Role signals');
    expect(content).toMatch(/0\s*\/\s*1/);
    expect(content).toMatch(/Missing Email\s*1/);
    expect(content).toMatch(/Missing Phone\s*1/);

    const inspectButton = container.querySelector(
      'button[aria-label="Inspect Public LinkedIn Dentist"]',
    );
    if (!inspectButton) {
      throw new Error('Could not find LinkedIn lead inspect button');
    }

    await clickElement(inspectButton);
    const expandedContent = normalizedText(container);
    expect(expandedContent).toContain('Lead snapshot');
    expect(expandedContent).toContain('Profile identity is public');
    expect(expandedContent).toContain('Public contact source: austindentalspa.example/contact');
    expect(expandedContent).toContain('Public match excerpt');
    expect(expandedContent).toContain('Dentist and practice owner in Austin, Texas.');
    expect(expandedContent).toContain('2 public result traces');
    expect(expandedContent).toContain('Brave Search');
    expect(expandedContent).toContain('Bing');
    expect(expandedContent).toContain('Category: Dentist, dental clinic');
    expect(expandedContent).toContain('Role: Founder, owner');
    expect(expandedContent).toContain('Public location: Austin, TX');
    expect(expandedContent).toContain('3 query paths · 2 public sources');
    expect(expandedContent).toContain('Brave Search + Bing');

    await unmount();
  });

  it('filters LinkedIn results by public match quality signals', async () => {
    const linkedinResponse: SearchResponse = {
      ...completedResponse,
      searchId: 'search-linkedin-quality-filters',
      leads: [
        {
          ...completedResponse.leads[0],
          source: 'LinkedIn, Public Profile',
          confidence: 94,
          publicEvidence: {
            profileSnippet: 'Public Dentist profile and business context.',
          },
          matchSignals: {
            queryMatches: 4,
            publicSources: 3,
            roleMatched: true,
            locationMatched: true,
          },
        },
        {
          ...completedResponse.leads[1],
          id: 'lead-linkedin-low-fit',
          source: 'LinkedIn, Public Profile',
          confidence: 68,
          matchSignals: {
            queryMatches: 1,
            publicSources: 1,
            roleMatched: false,
            locationMatched: true,
          },
        },
        {
          ...completedResponse.leads[1],
          id: 'lead-linkedin-unknown-location',
          name: 'Unverified Location Dentist',
          confidence: 94,
          matchSignals: {
            queryMatches: 3,
            publicSources: 2,
            roleMatched: true,
            locationMatched: false,
          },
        },
      ],
      meta: {
        ...completedResponse.meta,
        query: 'Dentist in Austin, TX',
        progress: {
          ...completedResponse.meta.progress,
          discovered: 2,
          enriched: 2,
          foundCount: 2,
          publicQueriesAttempted: 18,
          publicProvidersChecked: 3,
        },
      },
    };
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(linkedinResponse),
      getSearch: vi.fn().mockResolvedValue(linkedinResponse),
    };

    const { container, unmount } = await renderApp(['/search'], searchApi);

    await clickElement(getButton(container, /linkedin/i));
    await typeValue(getCompanyTypeInput(container), 'Dentist');
    await selectValue(getSelectByOptionValue(container, 'EST'), 'EST');
    await clickElement(getButton(container, /find leads/i));
    await waitForText(container, /public linkedin discovery complete/i, 6000);
    await waitForText(container, /Northstar Labs/i, 1000);

    expect(normalizedText(container)).toContain('3 visible leads');
    await clickElement(getCheckboxByLabel(container, /high-fit score/i));
    await waitForText(container, /Northstar Labs/i, 1000);
    expect(normalizedText(container)).toContain('1 visible leads');
    expect(normalizedText(container)).toContain('Northstar Labs');
    expect(normalizedText(container)).not.toContain('Unverified Location Dentist');

    await clickElement(getCheckboxByLabel(container, /cross-source match/i));
    expect(normalizedText(container)).toContain('1 visible leads');

    const rankSelect = container.querySelector('select[aria-label="Rank LinkedIn results"]');
    if (!rankSelect) {
      throw new Error('Could not find LinkedIn ranking select');
    }

    expect(Array.from((rankSelect as HTMLSelectElement).options).map((option) => option.value)).toEqual([
      'best-match',
      'contact-ready',
      'corroborated',
    ]);
    await selectValue(rankSelect as HTMLSelectElement, 'contact-ready');

    await clickElement(getCheckboxByLabel(container, /contact-ready/i));
    expect(normalizedText(container)).toContain('1 visible leads');

    await clickElement(getCheckboxByLabel(container, /public evidence available/i));
    expect(normalizedText(container)).toContain('1 visible leads');

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
