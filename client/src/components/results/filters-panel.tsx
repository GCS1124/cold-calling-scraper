import type { SearchSourceMode } from '../../data/search-options';

type Filters = {
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  highFitOnly: boolean;
  crossSourceOnly: boolean;
  contactReadyOnly: boolean;
  evidenceBackedOnly: boolean;
};

type FiltersPanelProps = {
  filters: Filters;
  onChange: (next: Filters) => void;
  sourceMode: SearchSourceMode;
};

export function FiltersPanel({ filters, onChange, sourceMode }: FiltersPanelProps) {
  const isLinkedInMode = sourceMode === 'linkedin';

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
        {isLinkedInMode ? (
          <>
            <div className="my-4 border-t border-slate-100 pt-4 text-xs font-semibold uppercase tracking-[0.16em] text-slate-400">
              Match quality
            </div>
            <label className="flex items-center gap-3">
              <input
                checked={filters.highFitOnly}
                onChange={(event) => onChange({ ...filters, highFitOnly: event.target.checked })}
                type="checkbox"
              />
              High-fit score (85%+ with location proof)
            </label>
            <label className="flex items-center gap-3">
              <input
                checked={filters.crossSourceOnly}
                onChange={(event) => onChange({ ...filters, crossSourceOnly: event.target.checked })}
                type="checkbox"
              />
              Cross-source match
            </label>
            <label className="flex items-center gap-3">
              <input
                checked={filters.contactReadyOnly}
                onChange={(event) => onChange({ ...filters, contactReadyOnly: event.target.checked })}
                type="checkbox"
              />
              Contact-ready (email or phone)
            </label>
            <label className="flex items-center gap-3">
              <input
                checked={filters.evidenceBackedOnly}
                onChange={(event) => onChange({ ...filters, evidenceBackedOnly: event.target.checked })}
                type="checkbox"
              />
              Public evidence available
            </label>
          </>
        ) : null}
      </div>
    </aside>
  );
}
