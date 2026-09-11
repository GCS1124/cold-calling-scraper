import type { Lead } from '../types/lead';

export const exportColumns = [
  'name',
  'organizationName',
  'decisionMakerName',
  'decisionMakerRole',
  'decisionMakerSourceUrl',
  'decisionMakerPhoneStatus',
  'decisionMakerPhoneAssociation',
  'decisionMakerPhoneSourceUrl',
  'originalRole',
  'normalizedRole',
  'decisionMaker',
  'employmentStatus',
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
  'independentSourceCount',
  'sourceFamilies',
  'phoneSources',
  'emailSources',
  'phoneAssociation',
  'lastObservedAt',
  'websiteStatus',
  'websiteScore',
  'websiteHost',
  'websiteObservedAt',
  'websiteReasons',
  'checksPending',
  'nextAction',
] as const;

export type ExportColumn = (typeof exportColumns)[number];

export const exportColumnLabels: Record<ExportColumn, string> = {
  name: 'Name',
  organizationName: 'Organization',
  decisionMakerName: 'Public decision-maker',
  decisionMakerRole: 'Decision-maker role',
  decisionMakerSourceUrl: 'Decision-maker source URL',
  decisionMakerPhoneStatus: 'Decision-maker + phone status',
  decisionMakerPhoneAssociation: 'Decision-maker phone association',
  decisionMakerPhoneSourceUrl: 'Decision-maker phone source URL',
  originalRole: 'Published role',
  normalizedRole: 'Normalized role',
  decisionMaker: 'Decision-maker signal',
  employmentStatus: 'Employment status',
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
  independentSourceCount: 'Independent source families',
  sourceFamilies: 'Source families',
  phoneSources: 'Phone evidence URLs',
  emailSources: 'Email evidence URLs',
  phoneAssociation: 'Phone association',
  lastObservedAt: 'Last phone observation',
  websiteStatus: 'Website identity status',
  websiteScore: 'Website identity score (not probability)',
  websiteHost: 'Assessed website host',
  websiteObservedAt: 'Website observation date',
  websiteReasons: 'Website identity evidence',
  checksPending: 'Unverified contact properties',
  nextAction: 'Recommended review',
};

export const defaultExportColumns = [
  'name',
  'organizationName',
  'decisionMakerName',
  'decisionMakerRole',
  'decisionMakerSourceUrl',
  'decisionMakerPhoneStatus',
  'decisionMakerPhoneAssociation',
  'decisionMakerPhoneSourceUrl',
  'originalRole',
  'normalizedRole',
  'decisionMaker',
  'employmentStatus',
  'mobile',
  'email',
  'website',
  'listingUrl',
  'contactSourceUrl',
  'confidence',
  'address',
  'qualityTier',
  'independentSourceCount',
  'sourceFamilies',
  'phoneSources',
  'phoneAssociation',
  'lastObservedAt',
  'websiteStatus',
  'websiteScore',
  'websiteHost',
  'websiteObservedAt',
  'websiteReasons',
  'checksPending',
  'nextAction',
] satisfies readonly ExportColumn[];

export const buildExportRows = (leads: Lead[], columns: readonly ExportColumn[]) =>
  leads.map((lead) => {
    const fields = {
      ...lead,
      organizationName: lead.organizationName ?? '',
      decisionMakerName: lead.decisionMakerName ?? '',
      decisionMakerRole: lead.decisionMakerRole ?? '',
      decisionMakerSourceUrl: lead.decisionMakerSourceUrl ?? '',
      decisionMakerPhoneStatus: lead.decisionMakerPhonePair?.status ?? 'unpaired',
      decisionMakerPhoneAssociation: lead.decisionMakerPhonePair?.phoneAssociation ?? 'unknown',
      decisionMakerPhoneSourceUrl: lead.decisionMakerPhonePair?.phoneSourceUrl ?? '',
      originalRole: lead.originalRole ?? lead.headline ?? '',
      normalizedRole: lead.normalizedRole ?? '',
      decisionMaker: lead.decisionMaker === true ? 'Yes' : lead.decisionMaker === false ? 'No' : '',
      employmentStatus: lead.employmentStatus ?? 'unverified',
      qualityTier: lead.quality?.tier ?? 'review',
      qualityScore: lead.quality?.score ?? '',
      independentSourceCount: lead.quality?.independentSourceCount ?? lead.scores?.independentSourceCount ?? '',
      sourceFamilies: (lead.quality?.sourceFamilies ?? lead.scores?.sourceFamilies ?? []).join(' | '),
      phoneSources: lead.quality?.phone.sourceUrls.join(' | ') ?? '',
      emailSources: lead.quality?.email.sourceUrls.join(' | ') ?? '',
      phoneAssociation: lead.quality?.phone.association ?? 'unknown',
      lastObservedAt: lead.quality?.lastObservedAt ?? '',
      websiteStatus: lead.websiteAssessment?.status ?? 'unknown',
      websiteScore: lead.websiteAssessment?.score ?? '',
      websiteHost: lead.websiteAssessment?.canonicalHost ?? '',
      websiteObservedAt: lead.websiteAssessment?.observedAt ?? '',
      websiteReasons: lead.websiteAssessment?.reasons.join(' | ') ?? '',
      checksPending: 'Line type, reachability, personal ownership, email delivery',
      nextAction: lead.quality?.nextAction ?? 'Refresh public contact evidence',
    };
    return columns.reduce<Record<string, string | number>>((row, column) => {
      row[column] = fields[column] ?? '';
      return row;
    }, {});
  });

export const buildCsv = (
  rows: Array<Record<string, string | number>>,
  columns: readonly ExportColumn[],
) => {
  const escapeValue = (value: string | number) => {
    const text = String(value);
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  const header = columns.map((column) => escapeValue(exportColumnLabels[column])).join(',');
  const body = rows.map((row) =>
    columns.map((column) => escapeValue(row[column] ?? '')).join(','),
  );

  return [header, ...body].join('\r\n') + '\r\n';
};

const buildDownloadFileName = (fileName: string, format: 'csv' | 'xlsx') => {
  const trimmedName = fileName.trim().replace(/\.(?:csv|xlsx)$/i, '');
  const baseName = Array.from(trimmedName, (character) =>
    character.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(character) ? '-' : character,
  )
    .join('')
    .replace(/\.+$/g, '')
    .trim();

  return `${baseName || 'lead-finder-export'}.${format}`;
};

const triggerDownload = (blob: Blob, fileName: string) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');

  anchor.download = fileName;
  anchor.href = url;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();

  window.setTimeout(() => {
    URL.revokeObjectURL(url);
    anchor.remove();
  }, 100);
};

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
  const rows = buildExportRows(leads, options.columns);
  const fileName = buildDownloadFileName(options.fileName, options.format);

  if (options.format === 'csv') {
    const blob = new Blob([buildCsv(rows, options.columns)], {
      type: 'text/csv;charset=utf-8',
    });
    triggerDownload(blob, fileName);
    return;
  }

  const { default: writeExcelFile } = await import('write-excel-file/browser');
  const sheetData = [
    options.columns.map((column) => exportColumnLabels[column]),
    ...rows.map((row) => options.columns.map((column) => row[column] ?? '')),
  ];

  const blob = await writeExcelFile(sheetData).toBlob();
  triggerDownload(blob, fileName);
};
