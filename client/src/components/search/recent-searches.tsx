import type { SearchHistoryItem } from '../../hooks/use-search-history';

type RecentSearchesProps = {
  items: SearchHistoryItem[];
  onApply: (item: SearchHistoryItem) => void;
};

export function RecentSearches({ items, onApply }: RecentSearchesProps) {
  const safeItems = items.filter((item): item is SearchHistoryItem => Boolean(item));

  if (!safeItems.length) {
    return null;
  }

  return (
    <div className="flex flex-wrap gap-2">
      {safeItems.map((item) => (
        <button
          key={item.id}
          className="rounded-full border border-slate-200 bg-white/70 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-blue-200 hover:text-blue-700"
          onClick={() => onApply(item)}
          type="button"
        >
          {item.companyType} · {item.locationLabel ?? item.city}
        </button>
      ))}
    </div>
  );
}
