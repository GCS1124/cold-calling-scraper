import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';

import App from '../App';
import type { SearchApi } from '../services/search-service';
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
    query: 'Dental Clinics in Austin, TX',
    locationLabel: 'Austin, TX',
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

const waitingResponse: SearchResponse = {
  searchId: 'search-waiting',
  leads: [],
  meta: {
    query: 'Dental Clinics in Austin, TX',
    locationLabel: 'Austin, TX',
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

describe('App', () => {
  it('shows the auth landing page at the base path', () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };

    render(
      <MemoryRouter initialEntries={['/']}>
        <App searchApi={searchApi} />
      </MemoryRouter>,
    );

    expect(screen.getByText(/sign in, create an account/i)).toBeTruthy();
    expect(screen.getByRole('link', { name: /go to search/i })).toBeTruthy();
  });

  it('keeps company type and city as typable inputs with suggestion dropdowns on the search route', () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };

    const { container } = render(
      <MemoryRouter initialEntries={['/search']}>
        <App searchApi={searchApi} />
      </MemoryRouter>,
    );

    const companyTypeInput = screen.getByLabelText(/company type/i);
    const cityInput = screen.getByLabelText(/city/i);

    expect(companyTypeInput.getAttribute('list')).toBe('company-type-options');
    expect(cityInput.getAttribute('list')).toBe('city-options');
    expect(screen.getByRole('combobox', { name: /company type/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /city/i })).toBeTruthy();
    expect(container.querySelector('#city-options option[value="USA"]')).not.toBeNull();
    expect(container.querySelector('#city-options option[value="California"]')).not.toBeNull();
  });

  it('submits a search and renders leads found by default', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(completedResponse),
      getSearch: vi.fn().mockResolvedValue(completedResponse),
    };
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/search']}>
        <App searchApi={searchApi} />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/company type/i), 'Dental Clinics');
    await user.type(screen.getByLabelText(/city/i), 'Austin');
    await user.click(screen.getByRole('button', { name: /find leads/i }));

    await waitFor(() => expect(searchApi.startSearch).toHaveBeenCalledOnce());
    expect(searchApi.startSearch).toHaveBeenCalledWith({
      companyType: 'Dental Clinics',
      city: 'Austin',
      count: 50,
    });

    expect(await screen.findByText('Northstar Labs')).toBeTruthy();
    expect(screen.getByText(/2 leads found for Dental Clinics in Austin, TX/i)).toBeTruthy();
    expect(screen.getByText('Orbit Data Works')).toBeTruthy();
    expect(screen.getByText(/South Congress/i)).toBeTruthy();
  });

  it('renders a simple leads found status without warning clutter', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(completedResponse),
      getSearch: vi.fn().mockResolvedValue(completedResponse),
    };
    const user = userEvent.setup();

    render(
      <MemoryRouter initialEntries={['/search']}>
        <App searchApi={searchApi} />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/company type/i), 'Dental Clinics');
    await user.type(screen.getByLabelText(/city/i), 'Austin');
    await user.click(screen.getByRole('button', { name: /find leads/i }));

    expect(await screen.findByText(/2 leads found for Dental Clinics in Austin, TX/i)).toBeTruthy();
    expect(screen.queryByLabelText(/show rejected leads/i)).toBeNull();
    expect(screen.queryByLabelText(/include partial leads/i)).toBeNull();
  });

  it('shows a waiting screen while the job is still running', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(waitingResponse),
      getSearch: vi.fn().mockResolvedValue(waitingResponse),
    };
    const user = userEvent.setup();

    const { unmount } = render(
      <MemoryRouter initialEntries={['/search']}>
        <App searchApi={searchApi} />
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText(/company type/i), 'Dental Clinics');
    await user.type(screen.getByLabelText(/city/i), 'Austin');
    await user.click(screen.getByRole('button', { name: /find leads/i }));

    expect(await screen.findByText(/waiting for the search to finish/i)).toBeTruthy();
    expect(screen.queryByText(/click any company row to verify details before export/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /download excel/i })).toBeNull();
    unmount();
  });

  it('shows the history page with downloadable saved searches', async () => {
    window.localStorage.setItem(
      'lead-finder-history',
      JSON.stringify([
        {
          id: 'history-1',
          searchId: 'search-1',
          companyType: 'Dental Clinics',
          city: 'Austin, TX',
          count: 50,
          locationLabel: 'Austin, TX',
          leadCount: 1,
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
          ],
          createdAt: '2026-04-21T00:00:00.000Z',
        },
      ]),
    );

    render(
      <MemoryRouter initialEntries={['/history']}>
        <App />
      </MemoryRouter>,
    );

    expect(await screen.findByText(/earlier searches, ready to reopen and download/i)).toBeTruthy();
    expect(screen.getAllByText('Dental Clinics').length).toBeGreaterThan(0);
    expect(screen.getByText('Northstar Labs')).toBeTruthy();
    expect(screen.getByRole('button', { name: /download/i })).toBeTruthy();
  });
});
