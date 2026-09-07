import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { describe, expect, it, vi } from 'vitest';
import type { Lead } from '../types/lead';
import { LeadQualityDetails, LeadQualityPanel } from '../components/results/lead-quality-details';
import { compareLeadQuality, matchesQualityFilter } from '../utils/lead-quality';
import { buildExportRows, canExportLead, downloadLeads } from '../utils/export';

const lead: Lead = {
  id: 'lead', name: 'Austin Dental', mobile: '+15125550101', email: '', website: 'https://dental.example',
  address: 'Austin, TX', city: 'Austin', category: 'Dentist', source: 'Google Places',
  confidence: 90, hasPhone: true, verifiedPhone: true, hasEmail: false, verifiedEmail: false,
  hasWebsite: true, scrapedAt: '2026-09-07T12:00:00Z',
  quality: {
    version: 1, tier: 'supported', score: 60, reasons: ['Valid US phone with public source evidence'],
    gaps: ['Personal ownership is unconfirmed'], sourceKinds: ['business_website'], freshness: 'recent',
    lastObservedAt: '2026-09-07T12:00:00Z', nextAction: 'Review the public contact page',
    phone: { assessedValue: '+15125550101', formatValid: true, publiclyObserved: true, association: 'business', sourceUrls: ['https://dental.example/contact'], lineType: 'unknown', reachability: 'not_checked' },
    email: { formatValid: false, publiclyObserved: false, sourceUrls: [], mailbox: 'not_checked' },
  },
};

describe('lead evidence UI', () => {
  it('shows sources, business association and unchecked properties without probability claims', () => {
    render(<LeadQualityDetails lead={lead} />);
    expect(screen.getByText('Business contact route')).toBeInTheDocument();
    expect(screen.getByText('Line type, reachability, email delivery')).toBeInTheDocument();
    expect(screen.getByText('60/100')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Phone source 1' })).toHaveAttribute('href', 'https://dental.example/contact');
    expect(screen.getByText(/Personal ownership is unconfirmed/)).toBeInTheDocument();
  });

  it('treats legacy leads as needing review and never displays excluded leads', () => {
    expect(matchesQualityFilter({ ...lead, quality: undefined }, 'review')).toBe(true);
    expect(matchesQualityFilter({ ...lead, quality: { ...lead.quality!, tier: 'excluded' } }, 'all')).toBe(false);
    expect(matchesQualityFilter(lead, 'corroborated')).toBe(false);
  });

  it('ranks current public evidence above an unsupported high score', () => {
    expect(compareLeadQuality(lead, { ...lead, quality: undefined, confidence: 100 })).toBeLessThan(0);
  });

  it('provides accessible quality filters for every source mode', () => {
    const onChange = vi.fn();
    render(<LeadQualityPanel leads={[lead]} value="all" onChange={onChange} />);
    const supported = screen.getByRole('button', { name: 'Public phone supported 1' });
    expect(supported).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(supported);
    expect(onChange).toHaveBeenCalledWith('supported');
  });

  it('carries evidence and limitations into exports', () => {
    expect(buildExportRows([lead], ['qualityTier', 'qualityScore', 'phoneSources', 'phoneAssociation', 'lastObservedAt', 'nextAction', 'checksPending'])[0]).toEqual({
      qualityTier: 'supported', qualityScore: 60, phoneSources: 'https://dental.example/contact',
      phoneAssociation: 'business', lastObservedAt: '2026-09-07T12:00:00Z', nextAction: 'Review the public contact page',
      checksPending: 'Line type, reachability, personal ownership, email delivery',
    });
  });

  it('blocks export when legacy or mismatched metadata cannot support the public phone', async () => {
    expect(canExportLead(lead)).toBe(true);
    expect(canExportLead({ ...lead, quality: undefined })).toBe(false);
    expect(canExportLead({ ...lead, mobile: '' })).toBe(false);
    expect(canExportLead({ ...lead, mobile: '+15125550999' })).toBe(false);
    expect(canExportLead({ ...lead, quality: { ...lead.quality!, phone: { ...lead.quality!.phone, publiclyObserved: false } } })).toBe(false);
    await expect(downloadLeads([{ ...lead, quality: undefined }], { fileName: 'test', format: 'csv', columns: ['name'] })).rejects.toThrow('Reverify public data');
  });
});
