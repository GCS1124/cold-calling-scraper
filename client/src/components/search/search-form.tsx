import { ChevronDown, LoaderCircle, Search } from 'lucide-react';
import type { FormEvent } from 'react';

import { cityOptions, companyTypeOptions } from '../../data/search-options';
import type { SearchRequest } from '../../types/lead';

type SearchFormProps = {
  value: SearchRequest;
  loading: boolean;
  onChange: (next: SearchRequest) => void;
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
            onChange={(event) =>
              onChange({
                ...value,
                companyType: event.target.value,
              })
            }
          />
          <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>
      </label>

      <label className="flex flex-col gap-2 text-sm font-semibold text-slate-900">
        City
        <div className="relative">
          <input
            className="h-12 w-full rounded-2xl border border-slate-200 bg-white px-4 pr-11 text-[15px] font-medium text-slate-950 outline-none transition focus:border-blue-500"
            list="city-options"
            placeholder="Austin, TX · California · USA"
            value={value.city}
            onChange={(event) =>
              onChange({
                ...value,
                city: event.target.value,
              })
            }
          />
          <ChevronDown className="pointer-events-none absolute right-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        </div>
      </label>

      <datalist id="company-type-options">
        {companyTypeOptions.map((option) => (
          <option key={option} value={option} />
        ))}
      </datalist>

      <datalist id="city-options">
        {cityOptions.map((option) => (
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
          onChange={(event) =>
            onChange({
              ...value,
              count: Number(event.target.value),
            })
          }
        />
      </label>

      <button
        className="inline-flex h-12 items-center justify-center gap-2 rounded-2xl bg-blue-600 px-5 text-sm font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400 md:col-span-2"
        disabled={loading || !value.companyType.trim() || !value.city.trim()}
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
