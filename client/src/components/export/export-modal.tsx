import { X } from 'lucide-react';
import { useState } from 'react';

import {
  defaultExportColumns,
  downloadLeads,
  exportColumns,
  type ExportColumn,
} from '../../utils/export';
import type { Lead } from '../../types/lead';

type ExportModalProps = {
  leads: Lead[];
  open: boolean;
  onClose: () => void;
};

export function ExportModal({ leads, open, onClose }: ExportModalProps) {
  const [fileName, setFileName] = useState('lead-finder-export');
  const [format, setFormat] = useState<'csv' | 'xlsx'>('xlsx');
  const [columns, setColumns] = useState<ExportColumn[]>([...defaultExportColumns]);

  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-slate-950/40 p-4 backdrop-blur-sm">
      <div className="w-full max-w-xl rounded-[28px] bg-white p-6 shadow-[0_30px_120px_rgba(15,23,42,0.18)]">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
              Export
            </p>
            <h3 className="mt-2 text-2xl font-semibold text-slate-950">
              Download {leads.length} lead{leads.length === 1 ? '' : 's'}
            </h3>
            <p className="mt-2 text-sm text-slate-500">
              Export defaults to qualified leads with both a valid US phone and email.
            </p>
          </div>
          <button onClick={onClose} type="button">
            <X className="h-5 w-5 text-slate-500" />
          </button>
        </div>

        <label className="mt-6 flex flex-col gap-2 text-sm font-semibold text-slate-900">
          File name
          <input
            className="h-12 rounded-2xl border border-slate-200 px-4"
            onChange={(event) => setFileName(event.target.value)}
            value={fileName}
          />
        </label>

        <label className="mt-4 flex flex-col gap-2 text-sm font-semibold text-slate-900">
          Format
          <select
            className="h-12 rounded-2xl border border-slate-200 px-4"
            onChange={(event) => setFormat(event.target.value as 'csv' | 'xlsx')}
            value={format}
          >
            <option value="xlsx">Excel (.xlsx)</option>
            <option value="csv">CSV (.csv)</option>
          </select>
        </label>

        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          {exportColumns.map((column) => {
            const checked = columns.includes(column);

            return (
              <label className="flex items-center gap-3 rounded-2xl border border-slate-200 px-3 py-2 text-sm" key={column}>
                <input
                  checked={checked}
                  onChange={(event) =>
                    setColumns((current) =>
                      event.target.checked
                        ? [...current, column]
                        : current.filter((item) => item !== column),
                    )
                  }
                  type="checkbox"
                />
                {column}
              </label>
            );
          })}
        </div>

        <button
          className="mt-6 inline-flex h-12 w-full items-center justify-center rounded-2xl bg-emerald-600 px-5 text-sm font-semibold text-white transition hover:bg-emerald-700"
          onClick={() => {
            downloadLeads(leads, {
              fileName: fileName || 'lead-finder-export',
              format,
              columns,
            });
            onClose();
          }}
          type="button"
        >
          Download file
        </button>
      </div>
    </div>
  );
}
