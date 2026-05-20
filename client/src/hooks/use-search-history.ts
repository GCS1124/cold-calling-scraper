import { useEffect, useState } from 'react';

import type { SearchRequest } from '../types/lead';

const storageKey = 'lead-finder-history:v1';

export type SearchHistoryItem = SearchRequest & {
  id: string;
  createdAt: string;
};

const readHistory = () => {
  if (typeof window === 'undefined') {
    return [] as SearchHistoryItem[];
  }

  try {
    const raw = window.localStorage.getItem(storageKey);
    return raw ? (JSON.parse(raw) as SearchHistoryItem[]) : [];
  } catch {
    return [];
  }
};

export const useSearchHistory = () => {
  const [items, setItems] = useState<SearchHistoryItem[]>(() => readHistory());

  useEffect(() => {
    window.localStorage.setItem(storageKey, JSON.stringify(items));
  }, [items]);

  const rememberSearch = (search: SearchRequest) => {
    setItems((current) => {
      const deduped = current.filter(
        (item) =>
          !(
            item.companyType.toLowerCase() === search.companyType.toLowerCase() &&
            item.city.toLowerCase() === search.city.toLowerCase()
          ),
      );

      return [
        {
          ...search,
          id: `${search.companyType}-${search.city}`.toLowerCase().replace(/\s+/g, '-'),
          createdAt: new Date().toISOString(),
        },
        ...deduped,
      ].slice(0, 10);
    });
  };

  return {
    items,
    rememberSearch,
  };
};
