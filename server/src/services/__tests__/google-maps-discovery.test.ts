import { describe, expect, it } from 'vitest';

import { formatGoogleMapsFailure, shouldFetchListingDetails } from '../google-maps-discovery';

describe('Google Maps fallback budget', () => {
  it('does not open a detail page when the result card already has a phone', () => {
    expect(
      shouldFetchListingDetails({
        name: 'Northstar Dental',
        listingUrl: 'https://www.google.com/maps/place/Northstar',
        phone: '+1 512 555 0101',
      }),
    ).toBe(false);
  });

  it('keeps detail recovery for candidates without a public phone', () => {
    expect(
      shouldFetchListingDetails({
        name: 'Phone Missing HVAC',
        listingUrl: 'https://www.google.com/maps/place/Phone-Missing',
      }),
    ).toBe(true);
  });

  it('turns browser resource failures into a bounded provider notice', () => {
    expect(
      formatGoogleMapsFailure(
        new Error('page.goto: net::ERR_INSUFFICIENT_RESOURCES at https://www.google.com/maps/'),
      ),
    ).toContain('existing results were preserved');
  });
});
