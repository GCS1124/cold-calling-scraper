import { describe, expect, it } from 'vitest';

import {
  filterSuppressedLeads,
  getLeadFeedbackSuppressionKeys,
  getLeadSuppressionLookupKeys,
} from '../lead-feedback';

const business = {
  id: 'business-1',
  name: 'North Star HVAC',
  mobile: '(512) 555-0100',
  hasPhone: true,
  website: 'https://www.northstar-hvac.example/contact',
  listingUrl: 'https://www.google.com/maps/place/North+Star+HVAC',
  city: 'Austin',
  stateCode: 'TX',
  source: 'Google Places',
};

describe('lead feedback keys', () => {
  it('normalizes phone formatting and uses business identity keys', () => {
    const keys = getLeadSuppressionLookupKeys(business);

    expect(keys).toContain(
      'phone-association:phone:5125550100|organization:north star hvac|austin|tx|northstar-hvac.example',
    );
    expect(keys).toContain('organization:north star hvac|austin|tx|northstar-hvac.example');
  });

  it('limits wrong-phone feedback to the business-phone association', () => {
    expect(getLeadFeedbackSuppressionKeys(business, 'wrong_phone')).toEqual([
      'phone-association:phone:5125550100|organization:north star hvac|austin|tx|northstar-hvac.example',
    ]);
    expect(getLeadFeedbackSuppressionKeys(business, 'useful')).toEqual([]);
  });

  it('filters only leads matching the owner suppression set', () => {
    const second = { ...business, id: 'business-2', mobile: '+1 (512) 555-0111' };
    const result = filterSuppressedLeads(
      [business, second],
      new Set([
        'phone-association:phone:5125550100|organization:north star hvac|austin|tx|northstar-hvac.example',
      ]),
    );

    expect(result.suppressedCount).toBe(1);
    expect(result.leads.map((lead) => lead.id)).toEqual(['business-2']);
  });
  it('keeps a branch correction from suppressing another branch on the same domain', () => {
    const firstBranch = {
      ...business,
      address: '123 Main St, Austin, TX',
    };
    const otherBranch = {
      ...firstBranch,
      id: 'business-branch-2',
      address: '456 Congress Ave, Austin, TX',
    };
    const suppressionKeys = new Set(
      getLeadFeedbackSuppressionKeys(firstBranch, 'wrong_business'),
    );

    expect(filterSuppressedLeads([firstBranch, otherBranch], suppressionKeys)).toEqual({
      leads: [otherBranch],
      suppressedCount: 1,
    });
  });

  it('keeps two public LinkedIn people at one employer distinct', () => {
    const firstPerson = {
      ...business,
      id: 'person-a',
      name: 'Alex Rivera',
      organizationName: 'North Star HVAC',
      listingUrl: 'https://www.linkedin.com/in/alex-rivera',
      website: 'https://northstar-hvac.example',
      city: '',
      stateCode: '',
      source: 'Public LinkedIn Search',
    };
    const secondPerson = {
      ...firstPerson,
      id: 'person-b',
      name: 'Jordan Lee',
      listingUrl: 'https://www.linkedin.com/in/jordan-lee',
    };
    const suppressionKeys = new Set(
      getLeadFeedbackSuppressionKeys(firstPerson, 'wrong_person'),
    );

    expect(filterSuppressedLeads([firstPerson, secondPerson], suppressionKeys)).toEqual({
      leads: [secondPerson],
      suppressedCount: 1,
    });
  });
});
