type Filters = {
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  source: string;
  includePartials: boolean;
  showRejected: boolean;
};

type FiltersPanelProps = {
  filters: Filters;
  sources: string[];
  onChange: (next: Filters) => void;
};

export function FiltersPanel({ filters, sources, onChange }: FiltersPanelProps) {
  return (
    <aside className="space-y-5 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
          Filters
        </p>
        <h3 className="mt-2 text-lg font-semibold text-slate-950">Tighten the lead pool</h3>
      </div>

      <div className="space-y-3 text-sm text-slate-700">
        <label className="flex items-center gap-3">
          <input
            checked={filters.hasEmail}
            onChange={(event) => onChange({ ...filters, hasEmail: event.target.checked })}
            type="checkbox"
          />
          Has Email
        </label>
        <label className="flex items-center gap-3">
          <input
            checked={filters.hasPhone}
            onChange={(event) => onChange({ ...filters, hasPhone: event.target.checked })}
            type="checkbox"
          />
          Has Phone
        </label>
        <label className="flex items-center gap-3">
          <input
            checked={filters.hasWebsite}
            onChange={(event) => onChange({ ...filters, hasWebsite: event.target.checked })}
            type="checkbox"
          />
          Has Website
        </label>
        <label className="flex items-center gap-3">
          <input
            checked={filters.includePartials}
            onChange={(event) => onChange({ ...filters, includePartials: event.target.checked })}
            type="checkbox"
          />
          Include partial leads
        </label>
        <label className="flex items-center gap-3">
          <input
            checked={filters.showRejected}
            onChange={(event) => onChange({ ...filters, showRejected: event.target.checked })}
            type="checkbox"
          />
          Show rejected leads
        </label>
      </div>

      <label className="flex flex-col gap-2 text-sm font-semibold text-slate-900">
        Source
        <select
          className="h-11 rounded-2xl border border-slate-200 bg-white px-3 text-sm font-medium text-slate-700 outline-none"
          value={filters.source}
          onChange={(event) => onChange({ ...filters, source: event.target.value })}
        >
          <option value="All">All sources</option>
          {sources.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
      </label>
    </aside>
  );
}
