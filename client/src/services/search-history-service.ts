import { getSupabaseClient } from '../lib/supabase';
import type { SearchRequest } from '../types/lead';

export type SearchHistoryItem = {
  id: string;
  companyType: string;
  city: string;
  count: number;
  locationLabel: string | null;
  createdAt: string;
};

type SearchHistoryRow = {
  id: string;
  company_type: string;
  city: string;
  count: number;
  location_label: string | null;
  created_at: string;
};

const HISTORY_SELECT = 'id, company_type, city, count, location_label, created_at';
const LOCAL_HISTORY_KEY = 'lead-finder-history';
let remoteHistoryAvailable: boolean | null = null;

const mapRow = (row: SearchHistoryRow): SearchHistoryItem => ({
  id: row.id,
  companyType: row.company_type,
  city: row.city,
  count: row.count,
  locationLabel: row.location_label,
  createdAt: row.created_at,
});

const isBrowser = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const readLocalHistory = (): SearchHistoryItem[] => {
  if (!isBrowser()) {
    return [];
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_HISTORY_KEY);
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as Array<Partial<SearchHistoryItem> | null>;
    return parsed
      .filter(
        (item): item is Partial<SearchHistoryItem> =>
          Boolean(item && item.id && item.companyType && item.city && item.count),
      )
      .map((item) => ({
        id: String(item.id),
        companyType: String(item.companyType),
        city: String(item.city),
        count: Number(item.count),
        locationLabel: item.locationLabel ? String(item.locationLabel) : null,
        createdAt: String(item.createdAt ?? new Date().toISOString()),
      }));
  } catch {
    return [];
  }
};

const writeLocalHistory = (items: SearchHistoryItem[]) => {
  if (!isBrowser()) {
    return;
  }

  window.localStorage.setItem(LOCAL_HISTORY_KEY, JSON.stringify(items.slice(0, 10)));
};

export const loadSearchHistory = async (
  userId?: string | null,
): Promise<SearchHistoryItem[]> => {
  const supabase = getSupabaseClient();

  if (!supabase || !userId || remoteHistoryAvailable === false) {
    return readLocalHistory();
  }

  const { data, error } = await supabase
    .from('search_history')
    .select(HISTORY_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    remoteHistoryAvailable = false;
    return readLocalHistory();
  }

  remoteHistoryAvailable = true;
  return (data ?? []).map((row) => mapRow(row as SearchHistoryRow));
};

export const rememberSearchHistory = async (
  search: SearchRequest,
  options: {
    userId?: string | null;
    locationLabel?: string | null;
  } = {},
): Promise<SearchHistoryItem> => {
  const supabase = getSupabaseClient();
  const localItem: SearchHistoryItem = {
    id: crypto.randomUUID(),
    companyType: search.companyType.trim(),
    city: search.city.trim(),
    count: search.count,
    locationLabel: options.locationLabel?.trim() || null,
    createdAt: new Date().toISOString(),
  };

  if (!supabase || !options.userId) {
    const current = readLocalHistory();
    const next = [localItem, ...current.filter((item) => item.id !== localItem.id)].slice(0, 10);
    writeLocalHistory(next);
    return localItem;
  }

  const payload = {
    user_id: options.userId,
    company_type: search.companyType.trim(),
    city: search.city.trim(),
    count: search.count,
    location_label: options.locationLabel?.trim() || null,
  };

  const { data, error } = await supabase
    .from('search_history')
    .insert(payload)
    .select(HISTORY_SELECT)
    .single();

  if (error) {
    remoteHistoryAvailable = false;
    const current = readLocalHistory();
    const next = [localItem, ...current.filter((item) => item.id !== localItem.id)].slice(0, 10);
    writeLocalHistory(next);
    return localItem;
  }

  const saved = mapRow(data as SearchHistoryRow);
  remoteHistoryAvailable = true;

  if (isBrowser()) {
    const current = readLocalHistory();
    const next = [saved, ...current.filter((item) => item.id !== saved.id)].slice(0, 10);
    writeLocalHistory(next);
  }

  return saved;
};
