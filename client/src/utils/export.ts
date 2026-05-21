import * as XLSX from 'xlsx';

import type { Lead } from '../types/lead';

export const exportColumns = [
  'name',
  'mobile',
  'email',
  'website',
  'address',
  'source',
] as const;

export const defaultExportColumns = [
  'name',
  'mobile',
  'email',
  'website',
  'address',
] as const;

export type ExportColumn = (typeof exportColumns)[number];

const toExportRows = (leads: Lead[], columns: ExportColumn[]) =>
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
  const rows = toExportRows(leads, options.columns);
  const workbook = XLSX.utils.book_new();
  const worksheet = XLSX.utils.json_to_sheet(rows);

  XLSX.utils.book_append_sheet(workbook, worksheet, 'Leads');
  XLSX.writeFile(workbook, `${options.fileName}.${options.format}`);
};
