import { useEffect, useState } from 'react';

import type { SearchRequest } from '../types/lead';
import {
  loadSearchHistory,
  rememberSearchHistory,
  type SearchHistoryItem,
} from '../services/search-history-service';

export type { SearchHistoryItem } from '../services/search-history-service';

export const useSearchHistory = (userId?: string | null) => {
  const [items, setItems] = useState<SearchHistoryItem[]>([]);

  useEffect(() => {
    let active = true;

    const sync = async () => {
      const nextItems = await loadSearchHistory(userId);
      if (active) {
        setItems(nextItems);
      }
    };

    void sync();

    return () => {
      active = false;
    };
  }, [userId]);

  const rememberSearch = async (search: SearchRequest, locationLabel?: string | null) => {
    const saved = await rememberSearchHistory(search, {
      userId,
      locationLabel,
    });

    if (!saved) {
      return null;
    }

    setItems((current) => {
      const next = [saved, ...current.filter((item) => item.id !== saved.id)];
      return next.slice(0, 10);
    });

    return saved;
  };

  return {
    items,
    rememberSearch,
  };
};
