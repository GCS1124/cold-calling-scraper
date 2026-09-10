import axios from 'axios';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { yellowPagesProvider } from '../yellowpages';
import { yelpProvider } from '../yelp';

const request = {
  rawQuery: 'HVAC contractor',
  query: 'HVAC contractor in Austin, TX',
  request: {
    companyType: 'HVAC contractor',
    city: 'Austin, TX',
    count: 50,
  },
};

afterEach(() => {
  vi.restoreAllMocks();
});
describe('public directory providers', () => {
  it('turns a visible Yelp business phone into public business evidence', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: `
        <ul>
          <li data-testid="serp-ia-card">
            <a href="/biz/austin-air-care">Austin Air Care</a>
            <span data-testid="phone">(512) 555-0198</span>
            <address>123 Congress Ave, Austin, TX 78701</address>
            <a href="https://austinaircare.example/contact">Website</a>
          </li>
        </ul>
      `,
    } as never);

    const leads = await yelpProvider.fetchLeads(request);
    const lead = leads[0];

    expect(lead).toMatchObject({
      name: 'Austin Air Care',
      mobile: '+15125550198',
      hasPhone: true,
      verifiedPhone: true,
      hasWebsite: true,
      listingUrl: 'https://www.yelp.com/biz/austin-air-care',
      source: 'Yelp',
    });
    expect(lead?.contactEvidence).toEqual([
      expect.objectContaining({
        field: 'phone',
        value: '+15125550198',
        sourceKind: 'business_listing',
        association: 'business',
        sourceName: 'Yelp, Public Directory',
      }),
    ]);
  });

  it('uses matching public JSON-LD when a Yelp card hides the phone in visible markup', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: `
        <li data-testid="serp-ia-card">
          <a href="/biz/central-texas-plumbing">Central Texas Plumbing</a>
          <address>Austin, TX</address>
        </li>
        <script type="application/ld+json">
          {"@type":"LocalBusiness","name":"Central Texas Plumbing","telephone":"(512) 555-0177","url":"https://centraltexasplumbing.example"}
        </script>
      `,
    } as never);

    const [lead] = await yelpProvider.fetchLeads({
      ...request,
      query: 'plumber in Austin, TX',
    });

    expect(lead?.mobile).toBe('+15125550177');
    expect(lead?.verifiedPhone).toBe(true);
    expect(lead?.website).toBe('https://centraltexasplumbing.example/');
  });

  it('normalizes Yellow Pages phones and rejects provider-owned URLs as business websites', async () => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 200,
      data: `
        <div class="result">
          <a class="business-name" href="/biz/lone-star-dental">Lone Star Dental</a>
          <div class="phones">(512) 555-0144</div>
          <a class="track-visit-website" href="https://www.yellowpages.com/biz/lone-star-dental">Website</a>
          <div class="street-address">401 Congress Ave</div>
          <div class="locality">Austin, TX 78701</div>
        </div>
      `,
    } as never);

    const [lead] = await yellowPagesProvider.fetchLeads({
      ...request,
      query: 'dentist in Austin, TX',
      request: { ...request.request, companyType: 'Dentist' },
    });

    expect(lead).toMatchObject({
      name: 'Lone Star Dental',
      mobile: '+15125550144',
      hasPhone: true,
      verifiedPhone: true,
      hasWebsite: false,
      listingUrl: 'https://www.yellowpages.com/biz/lone-star-dental',
      source: 'Yellow Pages',
    });
    expect(lead?.contactEvidence?.[0]).toEqual(
      expect.objectContaining({
        value: '+15125550144',
        sourceKind: 'business_listing',
        sourceName: 'Yellow Pages, Public Directory',
      }),
    );
  });

  it.each([
    ['Yelp', yelpProvider, 'Yelp blocked the request with a captcha or access challenge'],
    ['Yellow Pages', yellowPagesProvider, 'Yellow Pages blocked the request with a Cloudflare or access challenge'],
  ])('surfaces %s access challenges without fabricating leads', async (_name, provider, message) => {
    vi.spyOn(axios, 'get').mockResolvedValue({
      status: 403,
      data: '<html>Attention Required: Cloudflare captcha</html>',
    } as never);

    await expect(provider.fetchLeads(request)).rejects.toThrow(message);
  });
});
