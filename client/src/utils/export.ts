import type { Lead } from '../types/lead';

export const exportColumns = [
  'name',
  'mobile',
  'email',
  'website',
  'listingUrl',
  'contactSourceUrl',
  'confidence',
  'address',
  'source',
  'qualityTier',
  'qualityScore',
  'phoneSources',
  'emailSources',
  'phoneAssociation',
  'lastObservedAt',
  'checksPending',
  'nextAction',
] as const;

export type ExportColumn = (typeof exportColumns)[number];

export const exportColumnLabels: Record<ExportColumn, string> = {
  name: 'Name',
  mobile: 'Phone',
  email: 'Email',
  website: 'Business website',
  listingUrl: 'Listing / profile URL',
  contactSourceUrl: 'Contact source URL',
  confidence: 'Match score (not probability)',
  address: 'Address',
  source: 'Source',
  qualityTier: 'Contact evidence tier',
  qualityScore: 'Evidence score (not probability)',
  phoneSources: 'Phone evidence URLs',
  emailSources: 'Email evidence URLs',
  phoneAssociation: 'Phone association',
  lastObservedAt: 'Last phone observation',
  checksPending: 'Unverified contact properties',
  nextAction: 'Recommended review',
};

export const defaultExportColumns = [
  'name',
  'mobile',
  'email',
  'website',
  'listingUrl',
  'contactSourceUrl',
  'confidence',
  'address',
  'qualityTier',
  'phoneSources',
  'phoneAssociation',
  'lastObservedAt',
  'checksPending',
  'nextAction',
] satisfies readonly ExportColumn[];

export const buildExportRows = (leads: Lead[], columns: readonly ExportColumn[]) =>
  leads.map((lead) => {
    const fields = {
      ...lead,
      qualityTier: lead.quality?.tier ?? 'review',
      qualityScore: lead.quality?.score ?? '',
      phoneSources: lead.quality?.phone.sourceUrls.join(' | ') ?? '',
      emailSources: lead.quality?.email.sourceUrls.join(' | ') ?? '',
      phoneAssociation: lead.quality?.phone.association ?? 'unknown',
      lastObservedAt: lead.quality?.lastObservedAt ?? '',
      checksPending: 'Line type, reachability, personal ownership, email delivery',
      nextAction: lead.quality?.nextAction ?? 'Refresh public contact evidence',
    };
    return columns.reduce<Record<string, string | number>>((row, column) => {
      row[column] = fields[column] ?? '';
      return row;
    }, {});
  });

export const canExportLead = (lead: Lead) => Boolean(
  lead.hasPhone && lead.verifiedPhone && lead.mobile?.trim() &&
  lead.quality && lead.quality.tier !== 'excluded' && lead.quality.phone.formatValid &&
  lead.quality.phone.assessedValue === lead.mobile.trim() &&
  lead.quality.phone.publiclyObserved && lead.quality.phone.sourceUrls.length,
);

export const downloadLeads = async (
  leads: Lead[],
  options: { fileName: string; format: 'csv' | 'xlsx'; columns: ExportColumn[] },
) => {
  if (!leads.length || leads.some((lead) => !canExportLead(lead))) {
    throw new Error('Reverify public data before export: some leads lack current public-phone evidence metadata.');
  }
  const XLSX = await import('xlsx');
  const rows = buildExportRows(leads, options.columns);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
  XLSX.writeFile(workbook, `${options.fileName}.${options.format}`);
};
