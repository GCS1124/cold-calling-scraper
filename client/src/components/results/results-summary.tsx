type ResultsSummaryProps = {
  qualified: number;
  requested: number;
  companyType: string;
  city: string;
  missingEmail: number;
  missingPhone: number;
  blocked: number;
  duplicatesRemoved: number;
};

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-[20px] border border-slate-200 bg-slate-50 px-4 py-3">
      <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-slate-400">
        {label}
      </p>
      <p className="mt-2 text-2xl font-semibold text-slate-950">{value}</p>
    </div>
  );
}

export function ResultsSummary({
  qualified,
  requested,
  companyType,
  city,
  missingEmail,
  missingPhone,
  blocked,
  duplicatesRemoved,
}: ResultsSummaryProps) {
  return (
    <section className="grid gap-4 lg:grid-cols-[1.6fr_repeat(5,0.55fr)]">
      <div className="rounded-[24px] border border-slate-200 bg-white p-5 shadow-[0_24px_80px_rgba(15,23,42,0.08)]">
        <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
          Search Summary
        </p>
        <h2 className="mt-3 text-2xl font-semibold text-slate-950">
          {qualified} qualified leads ready for {companyType || 'your query'} in{' '}
          {city || 'your city'}
        </h2>
      </div>

      <Stat label="Requested" value={requested} />
      <Stat label="Missing Email" value={missingEmail} />
      <Stat label="Missing Phone" value={missingPhone} />
      <Stat label="Blocked" value={blocked} />
      <Stat label="Duplicates" value={duplicatesRemoved} />
    </section>
  );
}
