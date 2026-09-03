import { BriefcaseBusiness, Building2, LoaderCircle, Search, Sparkles } from 'lucide-react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';

import {
  companyTypeOptions,
  researchDepthOptions,
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
              ? 'AI mode searches public sources only: no paid databases, including commercial lead databases, private profiles, login sessions, or contact-reveal credits are used. Optional Gemini wording assistance is off by default.'
              : `${sourceModeLabelsByCode.gmb} keeps the search focused on local businesses, map-pack listings, and website-backed storefronts.`}
        </p>

        <div className="rounded-2xl border border-blue-100 bg-blue-50/70 px-4 py-3 text-xs font-normal leading-5 text-slate-600">
          <p className="font-bold text-blue-900">Mobile number required</p>
          <p className="mt-1">
            Only leads with a validated phone/mobile number publicly listed by the business are
            included. Private or Premium contact data is never accessed.
          </p>
        </div>

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
                  Up to 14 public business pages
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

      <fieldset className="space-y-3 text-sm font-semibold text-slate-900 md:col-span-2">
        <legend>Research depth</legend>
        <div className="grid gap-2 sm:grid-cols-3">
          {researchDepthOptions.map((option) => {
            const active = value.researchDepth === option.code;

            return (
              <button
                key={option.code}
                className={`rounded-2xl border px-4 py-3 text-left transition ${
                  active
                    ? 'border-blue-500 bg-blue-50 text-blue-950 shadow-sm'
                    : 'border-slate-200 bg-white text-slate-600 hover:border-blue-200 hover:bg-blue-50/40'
                }`}
                disabled={loading}
                onClick={() =>
                  onChange((current) => ({ ...current, researchDepth: option.code }))
                }
                type="button"
                aria-pressed={active}
              >
                <span className="block text-sm font-bold">{option.label}</span>
                <span className="mt-1 block text-xs font-normal text-slate-500">
                  {option.description}
                </span>
              </button>
            );
          })}
        </div>
        <p className="text-xs font-normal leading-5 text-slate-500">
          Every depth uses public sources. Deeper searches spend more time validating evidence and
          contact details, not accessing private or paid data.
        </p>
      </fieldset>

      {isAiMode ? (
        <>
          <label className="flex flex-col gap-2 text-sm font-semibold text-slate-900 md:col-span-2">
            Research brief <span className="font-normal text-slate-400">Optional</span>
            <textarea
              className="min-h-24 w-full resize-y rounded-2xl border border-slate-200 bg-white px-4 py-3 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
              maxLength={1_000}
              placeholder="Find owner-led HVAC companies in Austin that publicly list a mobile number and show signs they need a new website."
              value={value.researchBrief}
              onChange={(event) =>
                onChange((current) => ({ ...current, researchBrief: event.target.value }))
              }
            />
            <span className="text-xs font-normal leading-5 text-slate-500">
              AI turns this into a research plan. Gemini may help word queries, but public sources
              and deterministic checks decide what becomes a lead.
            </span>
          </label>

          <aside
            aria-label="AI interpretation preview"
            className="rounded-2xl border border-cyan-200 bg-cyan-50/80 p-4 text-sm text-slate-800 md:col-span-2"
          >
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-cyan-700 shadow-sm">
                <Sparkles className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <p className="font-bold text-cyan-950">AI interpretation preview</p>
                <p className="mt-1 leading-5 text-slate-600">
                  The search will use a bounded, public-only plan before any provider is called.
                </p>
              </div>
            </div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="rounded-xl border border-cyan-100 bg-white/80 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-700">Intent</p>
                <p className="mt-1 truncate text-sm font-semibold">
                  {value.researchBrief.trim() || 'Find decision-makers'}
                </p>
              </div>
              <div className="rounded-xl border border-cyan-100 bg-white/80 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-700">Scope</p>
                <p className="mt-1 truncate text-sm font-semibold">{locationSummary}</p>
              </div>
              <div className="rounded-xl border border-cyan-100 bg-white/80 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-700">Public lenses</p>
                <p className="mt-1 text-sm font-semibold">Listings, profiles, websites, social links</p>
              </div>
              <div className="rounded-xl border border-cyan-100 bg-white/80 p-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-cyan-700">Acceptance gate</p>
                <p className="mt-1 text-sm font-semibold">US phone + public evidence</p>
              </div>
            </div>
            <p className="mt-3 text-xs leading-5 text-slate-600">
              Paid databases, private profiles, login sessions, paywalls, contact-reveal credits,
              and CAPTCHA bypasses are excluded. Unsupported owner or mobile claims stay unknown.
            </p>
          </aside>
        </>
      ) : null}

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
