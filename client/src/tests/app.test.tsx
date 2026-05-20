import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

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
      source: 'OpenStreetMap, Website Crawl',
      confidence: 92,
      sourceScore: 80,
      qualified: true,
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
      qualified: false,
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
      qualifiedCount: 1,
      discardedCount: 1,
      blockedCount: 0,
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

describe('App', () => {
  it('keeps company type and city as typable inputs with suggestion dropdowns', () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn(),
      getSearch: vi.fn(),
    };

    const { container } = render(<App searchApi={searchApi} />);

    const companyTypeInput = screen.getByLabelText(/company type/i);
    const cityInput = screen.getByLabelText(/city/i);

    expect(companyTypeInput.getAttribute('list')).toBe('company-type-options');
    expect(cityInput.getAttribute('list')).toBe('city-options');
    expect(screen.getByRole('combobox', { name: /company type/i })).toBeTruthy();
    expect(screen.getByRole('combobox', { name: /city/i })).toBeTruthy();
    expect(container.querySelector('#city-options option[value="USA"]')).not.toBeNull();
    expect(container.querySelector('#city-options option[value="California"]')).not.toBeNull();
  });

  it('submits a search and renders qualified leads by default', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(completedResponse),
      getSearch: vi.fn().mockResolvedValue(completedResponse),
    };
    const user = userEvent.setup();

    render(<App searchApi={searchApi} />);

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
    expect(
      screen.getByText(/1 qualified leads ready for Dental Clinics in Austin, TX/i),
    ).toBeTruthy();
    expect(screen.queryByText('Orbit Data Works')).toBeNull();
    expect(screen.queryByText(/South Congress/i)).toBeNull();
  });

  it('renders inline provider warnings and bulk status details', async () => {
    const response: SearchResponse = {
      ...completedResponse,
      meta: {
        ...completedResponse.meta,
        status: 'enriching',
        progress: {
          ...completedResponse.meta.progress,
          enriched: 1,
          currentSource: 'Website Crawl',
        },
        providerWarnings: [
          {
            providerId: 'website-crawl',
            providerName: 'Website Crawl',
            message: 'orbitdataworks.com blocked contact crawling at https://orbitdataworks.com/contact',
          },
        ],
      },
    };

    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(response),
      getSearch: vi.fn().mockResolvedValue(completedResponse),
    };
    const user = userEvent.setup();

    render(<App searchApi={searchApi} />);

    await user.type(screen.getByLabelText(/company type/i), 'Dental Clinics');
    await user.type(screen.getByLabelText(/city/i), 'Austin');
    await user.click(screen.getByRole('button', { name: /find leads/i }));

    expect(await screen.findByText(/Enriching 1 of 2 candidates/i)).toBeTruthy();
    expect(screen.getByText(/Current source: Website Crawl/i)).toBeTruthy();
    expect(screen.getByText(/Website Crawl:/i)).toBeTruthy();
  });

  it('can include partial rows when the power-user toggle is enabled', async () => {
    const searchApi: SearchApi = {
      startSearch: vi.fn().mockResolvedValue(completedResponse),
      getSearch: vi.fn().mockResolvedValue(completedResponse),
    };
    const user = userEvent.setup();

    render(<App searchApi={searchApi} />);

    await user.type(screen.getByLabelText(/company type/i), 'Dental Clinics');
    await user.type(screen.getByLabelText(/city/i), 'Austin');
    await user.click(screen.getByRole('button', { name: /find leads/i }));

    await screen.findByText('Northstar Labs');
    const table = screen.getByRole('table', { name: /lead results/i });
    expect(within(table).getByText('Northstar Labs')).toBeTruthy();
    expect(within(table).queryByText('Orbit Data Works')).toBeNull();

    await user.click(screen.getByLabelText(/include partial leads/i));

    expect(within(table).getByText('Northstar Labs')).toBeTruthy();
    expect(within(table).getByText('Orbit Data Works')).toBeTruthy();
    expect(within(table).getByText(/missing email/i)).toBeTruthy();
  });
});
