import { getSupabaseClient } from '../lib/supabase';
import type { Lead } from '../types/lead';
import type { SearchRequest } from '../types/lead';

export type SearchHistoryItem = {
  id: string;
  searchId: string | null;
  companyType: string;
  city: string;
  count: number;
  locationLabel: string | null;
  leadCount: number;
  leads: Lead[];
  createdAt: string;
};

type SearchHistoryRow = {
  id: string;
  search_id: string | null;
  company_type: string;
  city: string;
  count: number;
  location_label: string | null;
  lead_count: number | null;
  leads: Lead[] | string | null;
  created_at: string;
};

const HISTORY_SELECT_SUMMARY =
  'id, search_id, company_type, city, count, location_label, lead_count, created_at';
const HISTORY_SELECT_DETAILS =
  'id, search_id, company_type, city, count, location_label, lead_count, leads, created_at';
const LOCAL_HISTORY_KEY = 'lead-finder-history';
const REMOTE_HISTORY_DISABLED_KEY = 'lead-finder-history-remote-disabled';
let remoteHistoryAvailable: boolean | null = null;

const parseLeads = (value: SearchHistoryRow['leads']): Lead[] => {
  if (!value) {
    return [];
  }

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value) as unknown;
      return Array.isArray(parsed) ? (parsed as Lead[]) : [];
    } catch {
      return [];
    }
  }

  return Array.isArray(value) ? value : [];
};

const mapRow = (row: SearchHistoryRow): SearchHistoryItem => {
  const leads = parseLeads(row.leads);

  return {
    id: row.id,
    searchId: row.search_id,
    companyType: row.company_type,
    city: row.city,
    count: row.count,
    locationLabel: row.location_label,
    leadCount: row.lead_count ?? leads.length,
    leads,
    createdAt: row.created_at,
  };
};

const isBrowser = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

const isRemoteHistoryDisabled = () => {
  if (!isBrowser()) {
    return false;
  }

  return window.sessionStorage.getItem(REMOTE_HISTORY_DISABLED_KEY) === '1';
};

const setRemoteHistoryDisabled = (disabled: boolean) => {
  if (!isBrowser()) {
    return;
  }

  if (disabled) {
    window.sessionStorage.setItem(REMOTE_HISTORY_DISABLED_KEY, '1');
    return;
  }

  window.sessionStorage.removeItem(REMOTE_HISTORY_DISABLED_KEY);
};

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
        searchId: item.searchId ? String(item.searchId) : null,
        companyType: String(item.companyType),
        city: String(item.city),
        count: Number(item.count),
        locationLabel: item.locationLabel ? String(item.locationLabel) : null,
        leadCount: Number(item.leadCount ?? item.leads?.length ?? 0),
        leads: Array.isArray(item.leads) ? (item.leads as Lead[]) : [],
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

  if (!supabase || !userId || remoteHistoryAvailable === false || isRemoteHistoryDisabled()) {
    return readLocalHistory();
  }

  const { data, error } = await supabase
    .from('search_history')
    .select(HISTORY_SELECT_SUMMARY)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    remoteHistoryAvailable = false;
    setRemoteHistoryDisabled(true);
    return readLocalHistory();
  }

  remoteHistoryAvailable = true;
  setRemoteHistoryDisabled(false);
  return (data ?? []).map((row) => ({
    ...mapRow(row as SearchHistoryRow),
    leads: [],
  }));
};

export const loadSearchHistoryDetails = async (
  userId?: string | null,
): Promise<SearchHistoryItem[]> => {
  const supabase = getSupabaseClient();

  if (!supabase || !userId || remoteHistoryAvailable === false || isRemoteHistoryDisabled()) {
    return readLocalHistory();
  }

  const { data, error } = await supabase
    .from('search_history')
    .select(HISTORY_SELECT_DETAILS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(10);

  if (error) {
    remoteHistoryAvailable = false;
    setRemoteHistoryDisabled(true);
    return readLocalHistory();
  }

  remoteHistoryAvailable = true;
  setRemoteHistoryDisabled(false);
  return (data ?? []).map((row) => mapRow(row as SearchHistoryRow));
};

export const rememberSearchHistory = async (
  search: SearchRequest,
  options: {
    userId?: string | null;
    locationLabel?: string | null;
    searchId?: string | null;
    leads?: Lead[];
  } = {},
): Promise<SearchHistoryItem> => {
  const supabase = getSupabaseClient();
  const localItem: SearchHistoryItem = {
    id: crypto.randomUUID(),
    searchId: options.searchId ?? null,
    companyType: search.companyType.trim(),
    city: search.city.trim(),
    count: search.count,
    locationLabel: options.locationLabel?.trim() || null,
    leadCount: options.leads?.length ?? 0,
    leads: options.leads ?? [],
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
    search_id: options.searchId ?? null,
    company_type: search.companyType.trim(),
    city: search.city.trim(),
    count: search.count,
    location_label: options.locationLabel?.trim() || null,
    lead_count: options.leads?.length ?? 0,
    leads: options.leads ?? [],
  };

  const { data, error } = await supabase
    .from('search_history')
    .insert(payload)
    .select(HISTORY_SELECT_DETAILS)
    .single();

  if (error) {
    remoteHistoryAvailable = false;
    setRemoteHistoryDisabled(true);
    const current = readLocalHistory();
    const next = [localItem, ...current.filter((item) => item.id !== localItem.id)].slice(0, 10);
    writeLocalHistory(next);
    return localItem;
  }

  const saved = mapRow(data as SearchHistoryRow);
  remoteHistoryAvailable = true;
  setRemoteHistoryDisabled(false);

  if (isBrowser()) {
    const current = readLocalHistory();
    const next = [saved, ...current.filter((item) => item.id !== saved.id)].slice(0, 10);
    writeLocalHistory(next);
  }

  return saved;
};
