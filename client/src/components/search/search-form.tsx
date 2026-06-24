import { LoaderCircle, Search } from 'lucide-react';
import type { Dispatch, FormEvent, SetStateAction } from 'react';

import { companyTypeOptions, timeZoneOptions } from '../../data/search-options';
import { usStates } from '../../data/us-states';
import { isSearchDraftComplete } from '../../utils/search-location';
import type { SearchDraft } from '../../types/lead';

type SearchFormProps = {
  value: SearchDraft;
  loading: boolean;
  onChange: Dispatch<SetStateAction<SearchDraft>>;
  onSubmit: () => void;
};

export function SearchForm({ value, loading, onChange, onSubmit }: SearchFormProps) {
  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit();
  };

  return (
    <form
      className="grid gap-5 rounded-[28px] border border-white/50 bg-white/82 p-5 shadow-[0_32px_120px_rgba(15,23,42,0.12)] backdrop-blur md:grid-cols-[1.1fr_0.85fr] md:p-7"
      onSubmit={handleSubmit}
    >
      <label className="flex flex-col gap-2 text-sm font-semibold text-slate-900">
        Company Type
        <div className="relative">
          <input
            className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 pr-11 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
            list="company-type-options"
            placeholder="dentist, roofer, hvac, law firm"
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
          <label className="flex flex-col gap-2 font-semibold text-slate-900">
            Time Zone
            <select
              className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
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
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
            <label className="flex flex-col gap-2 font-semibold text-slate-900">
              City
              <input
                className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
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

            <label className="flex flex-col gap-2 font-semibold text-slate-900">
              State
              <select
                className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
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
