import { describe, expect, it, vi } from 'vitest';
import type { Pool } from 'pg';

import type { Lead } from '../../types/lead';
import { createSearchJobRecord } from '../search-job-store';
import { persistNormalizedResearch } from '../research-normalizer';

const lead: Lead = {
  id: 'normalizer-lead',
  name: 'Jordan Lee',
  headline: 'Owner at Austin Dental',
  employmentStatus: 'probable',
  mobile: '+1 512 555 0101',
  email: 'owner@austindental.example',
  website: 'https://austindental.example',
  contactSourceUrl: 'https://austindental.example/contact',
  publicSocialLinks: [
    { platform: 'Facebook', url: 'https://facebook.com/austindental' },
  ],
  publicEvidence: {
    profileSnippet: 'Owner at Austin Dental in Austin, Texas.',
  },
  evidence: [
    {
      sourceUrl: 'https://austindental.example/contact',
      sourceName: 'Public website contact page',
      claim: 'The public website lists the phone number.',
      status: 'confirmed',
    },
  ],
  opportunitySignals: ['No online booking link observed'],
  address: 'Austin, TX',
  category: 'Dentist',
  city: 'Austin, TX',
  stateCode: 'TX',
  source: 'LinkedIn, Public Profile, Website Crawl',
  confidence: 90,
  hasEmail: true,
  hasPhone: true,
  hasWebsite: true,
  verifiedPhone: true,
  verifiedEmail: true,
  listingUrl: 'https://www.linkedin.com/in/jordan-lee',
  scrapedAt: '2026-09-04T00:00:00.000Z',
};

const job = createSearchJobRecord({
  searchId: 'normalizer-search',
  request: {
    companyType: 'Dentist',
    sourceMode: 'linkedin',
    city: 'Austin, TX',
    count: 50,
    phoneRequired: true,
  },
  query: 'Dentist in Austin, TX',
  locationLabel: 'Austin, TX',
  locationMode: 'local',
  status: 'complete',
  leads: [lead],
  progress: {
    discovered: 1,
    enriched: 1,
    publicContactsFound: 1,
    totalCandidates: 1,
    requestedCount: 50,
    foundCount: 1,
    duplicatesRemoved: 0,
    currentSource: 'Complete',
    batchesCompleted: 1,
    estimatedRemaining: 49,
  },
});

const makePool = (failOn?: RegExp) => {
  const query = vi.fn(async (text: string) => {
    if (failOn?.test(text)) {
      throw new Error('normalized table write failed');
    }

    if (text.includes('research_source_documents')) {
      return {
        rows: [
          {
            id: 'source-1',
            url: 'https://austindental.example/contact',
            name: 'Public evidence',
            family: 'public-website',
          },
        ],
      };
    }

    if (text.includes('research_people')) return { rows: [{ id: 'person-1' }] };
    if (text.includes('research_claims')) return { rows: [{ id: 'claim-1' }] };
    if (text.includes('research_opportunity_signals')) return { rows: [{ id: 'signal-1' }] };

    return { rows: [] };
  });
  const release = vi.fn();
  const connect = vi.fn().mockResolvedValue({ query, release });

  return {
    pool: { connect } as unknown as Pool,
    connect,
    query,
    release,
  };
};

describe('persistNormalizedResearch', () => {
  it('materializes terminal lead evidence in one transaction', async () => {
    const fake = makePool();

    await persistNormalizedResearch(fake.pool, job);

    const statements = fake.query.mock.calls.map(([statement]) => statement.toLowerCase());
    expect(fake.connect).toHaveBeenCalledOnce();
    expect(statements[0]).toBe('begin');
    expect(statements).toContainEqual(expect.stringContaining('research_source_documents'));
    expect(statements).toContainEqual(expect.stringContaining('research_people'));
    expect(statements).toContainEqual(expect.stringContaining('research_contact_points'));
    expect(statements).toContainEqual(expect.stringContaining('research_verification_events'));
    expect(statements).toContainEqual(expect.stringContaining('research_opportunity_signals'));
    expect(statements).toContainEqual(expect.stringContaining('research_lead_snapshots'));
    expect(statements.at(-1)).toBe('commit');
    expect(fake.release).toHaveBeenCalledOnce();
  });

  it('does not acquire a database connection for an active job', async () => {
    const fake = makePool();

    await persistNormalizedResearch(fake.pool, { ...job, status: 'discovering' });

    expect(fake.connect).not.toHaveBeenCalled();
  });

  it('rolls back and releases the client when normalized persistence fails', async () => {
    const fake = makePool(/research_people/);

    await expect(persistNormalizedResearch(fake.pool, job)).rejects.toThrow(
      'normalized table write failed',
    );

    const statements = fake.query.mock.calls.map(([statement]) => statement.toLowerCase());
    expect(statements).toContain('rollback');
    expect(fake.release).toHaveBeenCalledOnce();
  });
});
