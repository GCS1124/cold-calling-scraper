import type { ProviderWarning } from '../types/search';

export const noUsableResultsWarning = (): ProviderWarning => ({
  providerId: 'no-usable-results',
  providerName: 'Search validation',
  message:
    'No leads passed the required public phone/mobile and deterministic validation gate. The search was not marked complete.',
  severity: 'error',
});
