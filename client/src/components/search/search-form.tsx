import { BriefcaseBusiness, Building2, LoaderCircle, Search, Sparkles } from 'lucide-react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';

import {
  companyTypeOptions,
  sourceModeLabelsByCode,
  sourceModeOptions,
  timeZoneOptions,
} from '../../data/search-options';
import { usStates } from '../../data/us-states';
import { isSearchDraftComplete } from '../../utils/search-location';
import type { SearchDraft } from '../../types/lead';

type SearchFormProps = {
  value: SearchDraft;
  loading: boolean;
  onChange: Dispatch<SetStateAction<SearchDraft>>;
  onSourceModeChange: (sourceMode: SearchDraft['sourceMode']) => void;
  onSubmit: () => void;
};

export function SearchForm({
  value,
  loading,
  onChange,
  onSourceModeChange,
  onSubmit,
}: SearchFormProps) {
  const isLinkedInMode = value.sourceMode === 'linkedin';
  const isAiMode = value.sourceMode === 'ai';
  const companyTypePlaceholder = isLinkedInMode || isAiMode
    ? 'dentist, HVAC contractor, dental clinic'
    : 'dentist, plumber, roofer, HVAC contractor';
  const companyTypeHelp = isLinkedInMode
    ? 'Enter a business category. Public LinkedIn discovery expands it across founders, owners, CEOs, and relevant decision-makers.'
    : isAiMode
      ? 'Free AI mode expands the category into decision-maker searches, merges public results, and checks only publicly listed business contacts.'
      : 'Tailored to Google Business listings: try dentist, orthodontist, plumber, roofer, HVAC contractor, real estate agent, attorney, urgent care, mechanic, or commercial cleaning.';
  const locationSummary = value.locationMode === 'timezone'
    ? timeZoneOptions.find((option) => option.code === value.timeZone)?.label ?? 'Choose a time zone'
    : value.city.trim() && value.stateCode
      ? `${value.city.trim()}, ${value.stateCode}`
      : 'Choose a city and state';

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form
      className="grid gap-5 rounded-[28px] border border-white/50 bg-white/82 p-5 shadow-[0_32px_120px_rgba(15,23,42,0.12)] backdrop-blur md:grid-cols-[1.1fr_0.85fr] md:p-7"
      onSubmit={handleSubmit}
    >
      <fieldset className="space-y-3 text-sm font-semibold text-slate-900 md:col-span-2">
        <legend>Lead Source</legend>

        <div className="inline-flex w-full rounded-2xl bg-slate-100 p-1">
          {sourceModeOptions.map((option) => {
            const active = value.sourceMode === option.code;

            return (
              <button
                className={`flex flex-1 flex-col items-center justify-center rounded-2xl px-3 py-3 text-center transition ${
                  active
                    ? 'bg-white text-slate-950 shadow-sm'
                    : 'text-slate-500 hover:text-slate-800'
                }`}
                disabled={loading}
                key={option.code}
                onClick={() => {
                  if (option.code === value.sourceMode) {
                    return;
                  }

                  onChange((current) => ({ ...current, sourceMode: option.code }));
                  onSourceModeChange(option.code);
                }}
                type="button"
                aria-pressed={active}
              >
                <span className="flex items-center gap-2 text-sm font-semibold">
                  {option.code === 'gmb' ? (
                    <Building2 className="h-4 w-4" />
                  ) : option.code === 'ai' ? (
                    <Sparkles className="h-4 w-4" />
                  ) : (
                    <BriefcaseBusiness className="h-4 w-4" />
                  )}
                  {option.label}
                </span>
                <span className="mt-1 text-[11px] font-medium uppercase tracking-[0.18em] text-slate-400">
                  {option.hint}
                </span>
              </button>
            );
          })}
        </div>

        <p className="text-xs font-normal leading-5 text-slate-500">
          {isLinkedInMode
            ? `${sourceModeLabelsByCode.linkedin} searches public profiles only. Phone numbers and emails are collected only from public business websites.`
            : isAiMode
              ? 'AI mode is free-only: no paid databases, private profiles, login sessions, or contact-reveal credits are used.'
              : `${sourceModeLabelsByCode.gmb} keeps the search focused on local businesses, map-pack listings, and website-backed storefronts.`}
        </p>

        {isLinkedInMode ? (
          <div className="overflow-hidden rounded-2xl border border-slate-800 bg-gradient-to-br from-slate-950 via-slate-900 to-blue-950 p-4 text-white shadow-[0_18px_50px_rgba(15,23,42,0.18)]">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-blue-200">
                  LinkedIn discovery recipe
                </p>
                <p className="mt-1 text-sm leading-5 text-slate-300">
                  A focused public-web workflow for finding the people behind the category.
                </p>
              </div>
              <span className="shrink-0 rounded-full border border-blue-300/30 bg-blue-300/10 px-3 py-1 text-[11px] font-bold text-blue-100">
                Public signals
              </span>
            </div>

            <div className="mt-4 grid gap-2 sm:grid-cols-3">
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <p className="text-sm font-bold">Role expansion</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Owners, founders, and decision-makers
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <p className="text-sm font-bold">Location precision</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  City, state, and regional signals
                </p>
              </div>
              <div className="rounded-xl border border-white/10 bg-white/5 p-3">
                <p className="text-sm font-bold">Public-site enrichment</p>
                <p className="mt-1 text-xs leading-5 text-slate-400">
                  Openly listed business contact details
                </p>
              </div>
            </div>

            <div className="mt-3 rounded-xl border border-white/10 bg-slate-950/35 p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                <p className="text-[11px] font-bold uppercase tracking-[0.18em] text-slate-400">
                  Live search blueprint
                </p>
                <span className="text-[11px] font-semibold text-blue-200">
                  Built from your inputs
                </span>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Category
                  </p>
                  <p className="mt-1 truncate text-sm font-semibold text-white">
                    {value.companyType.trim() || 'Your business type'}
                  </p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Region
                  </p>
                  <p className="mt-1 truncate text-sm font-semibold text-white">{locationSummary}</p>
                </div>
                <div>
                  <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    Intent
                  </p>
                  <p className="mt-1 truncate text-sm font-semibold text-white">Decision-makers</p>
                </div>
              </div>
            </div>
          </div>
        ) : null}
      </fieldset>

      <label className="flex flex-col gap-2 text-sm font-semibold text-slate-900">
        Company Type
        <div className="relative">
          <input
            className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 pr-11 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
            aria-describedby="company-type-help"
            list="company-type-options"
            placeholder={companyTypePlaceholder}
            value={value.companyType}
            onChange={(event) => {
              const nextCompanyType = event.target.value;

              onChange((current) => ({
                ...current,
                companyType: nextCompanyType,
              }));
            }}
          />
        </div>
        <p id="company-type-help" className="text-xs font-normal leading-5 text-slate-500">
          {companyTypeHelp}
        </p>
      </label>

      <fieldset className="space-y-3 text-sm font-semibold text-slate-900">
        <legend>Location</legend>

        <div className="inline-flex w-full rounded-2xl bg-slate-100 p-1">
          <button
            className={`flex-1 rounded-2xl px-3 py-2 text-sm font-semibold transition ${
              value.locationMode === 'timezone'
                ? 'bg-white text-slate-950 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
            onClick={() => onChange((current) => ({ ...current, locationMode: 'timezone' }))}
            type="button"
            aria-pressed={value.locationMode === 'timezone'}
          >
            Time Zone
          </button>
          <button
            className={`flex-1 rounded-2xl px-3 py-2 text-sm font-semibold transition ${
              value.locationMode === 'cityState'
                ? 'bg-white text-slate-950 shadow-sm'
                : 'text-slate-500 hover:text-slate-800'
            }`}
            onClick={() => onChange((current) => ({ ...current, locationMode: 'cityState' }))}
            type="button"
            aria-pressed={value.locationMode === 'cityState'}
          >
            City / State
          </button>
        </div>

        {value.locationMode === 'timezone' ? (
          <label className="grid min-w-0 gap-2 font-semibold text-slate-900">
            Time Zone
            <select
              className="h-12 w-full min-w-0 rounded-2xl border border-slate-200 bg-white px-4 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
              value={value.timeZone}
              onChange={(event) => {
                const nextTimeZone = event.target.value as SearchDraft['timeZone'];

                onChange((current) => ({
                  ...current,
                  timeZone: nextTimeZone,
                }));
              }}
            >
              <option value="">Select a time zone</option>
              {timeZoneOptions.map((option) => (
                <option key={option.code} value={option.code}>
                  {option.label} ({option.code})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,11rem)]">
            <label className="grid min-w-0 gap-2 font-semibold text-slate-900">
              City
              <input
                className="h-12 w-full min-w-0 rounded-2xl border border-slate-200 bg-white px-4 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
                placeholder="Austin, Phoenix, Miami"
                value={value.city}
                onChange={(event) => {
                  const nextCity = event.target.value;

                  onChange((current) => ({
                    ...current,
                    city: nextCity,
                  }));
                }}
              />
            </label>

            <label className="grid min-w-0 gap-2 font-semibold text-slate-900">
              State
              <select
                className="h-12 w-full min-w-0 rounded-2xl border border-slate-200 bg-white px-4 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
                value={value.stateCode}
                onChange={(event) => {
                  const nextStateCode = event.target.value as SearchDraft['stateCode'];

                  onChange((current) => ({
                    ...current,
                    stateCode: nextStateCode,
                  }));
                }}
              >
                <option value="">Select</option>
                {usStates.map((state) => (
                  <option key={state.code} value={state.code}>
                    {state.name} ({state.code})
                  </option>
                ))}
              </select>
            </label>
          </div>
        )}
      </fieldset>

      <datalist id="company-type-options">
        {companyTypeOptions.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>

      <label className="flex flex-col gap-3 text-sm font-semibold text-slate-900 md:col-span-2">
        Results: <span className="font-mono text-blue-700">{value.count}</span>
        <input
          type="range"
          min={50}
          max={500}
          step={25}
          value={value.count}
          onChange={(event) => {
            const nextCount = Number(event.target.value);

            onChange((current) => ({
              ...current,
              count: nextCount,
            }));
          }}
        />
      </label>

      <button
        className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400 md:col-span-2"
        disabled={loading || !isSearchDraftComplete(value)}
        type="submit"
      >
        {loading ? (
          <>
            <LoaderCircle className="h-4 w-4 animate-spin" />
            Searching
          </>
        ) : (
          <>
            <Search className="h-4 w-4" />
            Find Leads
          </>
        )}
      </button>
    </form>
  );
}
