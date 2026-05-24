import { useEffect, useState } from 'react';

import type { SearchRequest } from '../types/lead';
import {
  loadSearchHistoryDetails,
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

  const rememberSearch = async (
    search: SearchRequest,
    options?: {
      locationLabel?: string | null;
      searchId?: string | null;
      leads?: SearchHistoryItem['leads'];
    },
  ) => {
    const saved = await rememberSearchHistory(search, {
      userId,
      locationLabel: options?.locationLabel,
      searchId: options?.searchId,
      leads: options?.leads,
    });

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

export const useSearchHistoryDetails = (userId?: string | null) => {
  const [items, setItems] = useState<SearchHistoryItem[]>([]);

  useEffect(() => {
    let active = true;

    const sync = async () => {
      const nextItems = await loadSearchHistoryDetails(userId);
      if (active) {
        setItems(nextItems);
      }
    };

    void sync();

    return () => {
      active = false;
    };
  }, [userId]);

  return { items, setItems };
};
