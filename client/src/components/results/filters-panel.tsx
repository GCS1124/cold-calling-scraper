type Filters = {
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
};

type FiltersPanelProps = {
  filters: Filters;
  onChange: (next: Filters) => void;
};

export function FiltersPanel({ filters, onChange }: FiltersPanelProps) {
  return (
    <aside className="space-y-5 rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
      <div>
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
          Filters
        </p>
        <h3 className="mt-2 text-lg font-semibold text-slate-950">Filter results</h3>
      </div>

      <div className="space-y-3 text-sm text-slate-700">
        <label className="flex items-center gap-3">
          <input
            checked={filters.hasEmail}
            onChange={(event) => onChange({ ...filters, hasEmail: event.target.checked })}
            type="checkbox"
          />
          Email
        </label>
        <label className="flex items-center gap-3">
          <input
            checked={filters.hasPhone}
            onChange={(event) => onChange({ ...filters, hasPhone: event.target.checked })}
            type="checkbox"
          />
          Phone
        </label>
        <label className="flex items-center gap-3">
          <input
            checked={filters.hasWebsite}
            onChange={(event) => onChange({ ...filters, hasWebsite: event.target.checked })}
            type="checkbox"
          />
          Website
        </label>
      </div>
    </aside>
  );
}
