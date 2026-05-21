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

const mapRow = (row: SearchHistoryRow): SearchHistoryItem => ({
  id: row.id,
  companyType: row.company_type,
  city: row.city,
  count: row.count,
  locationLabel: row.location_label,
  createdAt: row.created_at,
});

export const loadSearchHistory = async (
  userId?: string | null,
): Promise<SearchHistoryItem[]> => {
  const supabase = getSupabaseClient();

  if (!supabase || !userId) {
    return [];
  }

  const { data, error } = await supabase
    .from('search_history')
    .select(HISTORY_SELECT)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    throw error;
  }

  return (data ?? []).map((row) => mapRow(row as SearchHistoryRow));
};

export const rememberSearchHistory = async (
  search: SearchRequest,
  options: {
    userId?: string | null;
    locationLabel?: string | null;
  },
): Promise<SearchHistoryItem | null> => {
  const supabase = getSupabaseClient();

  if (!supabase || !options.userId) {
    return null;
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
    throw error;
  }

  return mapRow(data as SearchHistoryRow);
};
