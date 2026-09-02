/**
 * Commercial provider audit metadata.
 *
 * AI mode is intentionally free-only. These vendors are documented here so
 * the product can explain the audit and its limitations, but no vendor
 * endpoint, credential, browser session, or enrichment credit is used.
 */
export type SalesProviderAudit = {
  id: 'apollo' | 'lusha' | 'zoominfo' | 'rocketreach';
  name: string;
  officialUrl: string;
  accessModel: 'commercial';
  freeModeStatus: 'not_used';
  limitation: string;
};

export const salesProviderAudits: SalesProviderAudit[] = [
  {
    id: 'apollo',
    name: 'Apollo',
    officialUrl: 'https://www.apollo.io/',
    accessModel: 'commercial',
    freeModeStatus: 'not_used',
    limitation: 'Commercial API and contact reveal access are not called by free AI mode.',
  },
  {
    id: 'lusha',
    name: 'Lusha',
    officialUrl: 'https://www.lusha.com/',
    accessModel: 'commercial',
    freeModeStatus: 'not_used',
    limitation: 'Commercial prospecting and contact reveal access are not called by free AI mode.',
  },
  {
    id: 'zoominfo',
    name: 'ZoomInfo',
    officialUrl: 'https://www.zoominfo.com/',
    accessModel: 'commercial',
    freeModeStatus: 'not_used',
    limitation: 'Enterprise search and enrichment access are not called by free AI mode.',
  },
  {
    id: 'rocketreach',
    name: 'RocketReach',
    officialUrl: 'https://rocketreach.co/',
    accessModel: 'commercial',
    freeModeStatus: 'not_used',
    limitation: 'No documented public free extraction contract was used or inferred.',
  },
];

export const freeAiModePolicy =
  'Free AI mode uses public search results and publicly listed business contact details only. It does not use paid databases, private profiles, login sessions, paywall bypasses, or contact-reveal credits.';
