import * as XLSX from 'xlsx';

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
] as const;

export type ExportColumn = (typeof exportColumns)[number];

export const exportColumnLabels: Record<ExportColumn, string> = {
  name: 'Name',
  mobile: 'Phone',
  email: 'Email',
  website: 'Business website',
  listingUrl: 'Listing / profile URL',
  contactSourceUrl: 'Contact source URL',
  confidence: 'Match confidence',
  address: 'Address',
  source: 'Source',
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
] satisfies readonly ExportColumn[];

export const buildExportRows = (leads: Lead[], columns: readonly ExportColumn[]) =>
  leads.map((lead) =>
    columns.reduce<Record<string, string | number>>((row, column) => {
      row[column] = lead[column] ?? '';
      return row;
    }, {}),
  );

export const downloadLeads = (
  leads: Lead[],
  options: { fileName: string; format: 'csv' | 'xlsx'; columns: ExportColumn[] },
) => {
  const rows = buildExportRows(leads, options.columns);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
  XLSX.writeFile(workbook, `${options.fileName}.${options.format}`);
};
