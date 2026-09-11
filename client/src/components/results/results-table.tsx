import { ExternalLink, Copy, CheckSquare, Square } from 'lucide-react';
import { ChevronDown } from 'lucide-react';
import { Fragment, useState } from 'react';

import type { Lead } from '../../types/lead';
import type { LeadFeedbackEventType } from '../../../../shared/lead-feedback';
import { LeadQualityBadge, LeadQualityDetails } from './lead-quality-details';
import {
  getLinkedInQualityTier,
  getLinkedInReadinessLabel,
  hasPublicOwnerSignal,
  isHighFitLinkedInLead,
} from '../../utils/linkedin-quality';
import {
  getPublicSourceOrder,
  getPublicSourcePriority,
  publicLeadSourceOrderLabels,
} from '../../utils/source-priority';

type ResultsTableProps = {
  leads: Lead[];
  emptyStateMessage?: string;
  selectedIds: string[];
  onToggleSelect: (leadId: string) => void;
  onSelectAll: () => void;
  onCopyRow: (lead: Lead) => void;
  onFeedback: (lead: Lead, eventType: LeadFeedbackEventType) => void;
  showSourceSequence?: boolean;
};

type ContactCellProps = {
  value?: string;
  verified: boolean;
  publiclyObserved?: boolean;
};

function isPublicLinkedInLead(lead: Lead) {
  return lead.source.toLowerCase().includes('linkedin');
}

const employmentStatusLabels: Record<NonNullable<Lead['employmentStatus']>, string> = {
  current: 'Current role signal',
  probable: 'Probable current role',
  uncertain: 'Role status uncertain',
  conflicting: 'Conflicting role signals',
  former: 'Former role signal',
  unverified: 'Employment unverified',
};

const queryFamilyLabels: Record<string, string> = {
  'category-location': 'Category + location',
  'legacy-profile': 'Legacy profile',
  'multi-term-cluster': 'Multi-term cluster',
  'owner-led': 'Owner/founder path',
  'role-led': 'Role-led',
};

function ContactCell({ value, verified, publiclyObserved }: ContactCellProps) {
  if (!value) {
    return <>—</>;
  }

  return (
    <div className="min-w-[130px]">
      <span className="block">{value}</span>
      {verified ? (
        <span
          className="mt-1 block text-[10px] font-bold uppercase tracking-[0.12em] text-emerald-700"
          title="Public observation and format checks do not establish reachability, personal ownership, or email delivery."
        >
          {publiclyObserved ? 'Publicly listed' : 'Format checked'}
        </span>
      ) : null}
    </div>
  );
}

export function ResultsTable({
  leads,
  emptyStateMessage = 'No leads match the current filters.',
  selectedIds,
  onToggleSelect,
  onSelectAll,
  onCopyRow,
  onFeedback,
  showSourceSequence = false,
}: ResultsTableProps) {
  const allSelected = leads.length > 0 && leads.every((lead) => selectedIds.includes(lead.id));
  const [expandedLeadId, setExpandedLeadId] = useState<string | null>(null);
  const containsLinkedInLeads = leads.some(isPublicLinkedInLead);
  const allLeadsAreLinkedIn = leads.length > 0 && leads.every(isPublicLinkedInLead);
  const identityColumnLabel = allLeadsAreLinkedIn
    ? 'Profile'
    : containsLinkedInLeads
      ? 'Profile / Company'
      : 'Company / person';
  const linkColumnLabel = allLeadsAreLinkedIn ? 'Profile / Website' : 'Website / Profile';
  const inspectionCopy = allLeadsAreLinkedIn
    ? 'Inspect public profile evidence before export.'
    : containsLinkedInLeads
      ? 'Inspect profile or company details before export.'
      : 'Open a company name to inspect details before export.';

  return (
    <div className="overflow-hidden rounded-[24px] border border-slate-200 bg-white shadow-[0_24px_80px_rgba(15,23,42,0.08)] [container-type:inline-size]">
      <div className="flex items-center justify-between border-b border-slate-200 px-5 py-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.22em] text-slate-400">
            Results
          </p>
          <p className="mt-1 text-sm text-slate-600">
            {inspectionCopy}
          </p>
        </div>

        <button
          className="inline-flex items-center gap-2 rounded-full border border-slate-200 px-3 py-2 text-xs font-semibold text-slate-600 transition hover:border-blue-200 hover:text-blue-700"
          onClick={onSelectAll}
          type="button"
        >
          {allSelected ? <CheckSquare className="h-4 w-4" /> : <Square className="h-4 w-4" />}
          {allSelected ? 'Clear visible' : 'Select visible'}
        </button>
      </div>

      <div className="overflow-x-auto">
        <table aria-label="Lead results" className="min-w-full text-left text-sm text-slate-700">
          <thead className="bg-slate-50 text-xs uppercase tracking-[0.18em] text-slate-400">
            <tr>
              <th className="px-4 py-3">#</th>
              <th className="px-4 py-3">{identityColumnLabel}</th>
              <th className="px-4 py-3">Phone</th>
              <th className="px-4 py-3">Email</th>
              <th className="px-4 py-3">{linkColumnLabel}</th>
              <th className="px-4 py-3">Address</th>
              <th className="px-4 py-3">Source</th>
              <th className="px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {leads.map((lead, index) => {
              const isSelected = selectedIds.includes(lead.id);
              const isLinkedInLead = isPublicLinkedInLead(lead);
              const profileUrl = isLinkedInLead ? lead.listingUrl : undefined;
              const websiteUrl = lead.website && lead.website !== profileUrl ? lead.website : undefined;
              const fallbackUrl = !profileUrl && !websiteUrl ? lead.listingUrl : undefined;
              const primaryActionUrl = profileUrl || websiteUrl || fallbackUrl;
              const primaryActionLabel = profileUrl
                ? 'LinkedIn profile'
                : websiteUrl
                  ? 'business website'
                  : 'lead source';
              const isExpanded = expandedLeadId === lead.id;
              const isStrongMatch = isLinkedInLead
                ? isHighFitLinkedInLead(lead)
                : lead.confidence >= 85;
              const hasOwnerSignal = isLinkedInLead && hasPublicOwnerSignal(lead);
              const qualityTier = isLinkedInLead ? getLinkedInQualityTier(lead) : undefined;
              const sourcePriority = getPublicSourcePriority(lead);
              const sourceOrder = getPublicSourceOrder(lead);
              const hasBusinessPhonePair =
                lead.decisionMakerPhonePair?.status === 'paired' &&
                lead.decisionMakerPhonePair.phoneAssociation === 'business';
              const hasPublicPhonePair = lead.decisionMakerPhonePair?.status === 'paired';
              const matchLabel =
                isStrongMatch
                  ? 'Strong match'
                  : lead.confidence >= 70
                    ? 'Good match'
                    : 'Potential match';

              return (
                <Fragment key={lead.id}>
                  <tr className="border-t border-slate-100 transition hover:bg-blue-50/40">
                    <td className="px-4 py-4">
                      <button
                        aria-label={`Select ${lead.name}`}
                        className="text-blue-700"
                        onClick={() => onToggleSelect(lead.id)}
                        type="button"
                      >
                        {isSelected ? (
                          <CheckSquare className="h-4 w-4" />
                        ) : (
                          <Square className="h-4 w-4" />
                        )}
                      </button>
                      <span className="ml-3 text-xs text-slate-400">{index + 1}</span>
                    </td>
                    <td className="px-4 py-4">
                      <button
                        aria-controls={`lead-details-${lead.id}`}
                        aria-expanded={isExpanded}
                        aria-label={`${isExpanded ? 'Hide' : 'Inspect'} ${lead.name}`}
                        className="inline-flex max-w-full items-center gap-2 text-left font-semibold text-slate-950 transition hover:text-blue-700"
                        onClick={() => setExpandedLeadId(isExpanded ? null : lead.id)}
                        type="button"
                      >
                        <span className="truncate">{lead.name}</span>
                        <ChevronDown
                          className={`h-4 w-4 shrink-0 text-slate-400 transition ${isExpanded ? 'rotate-180' : ''}`}
                        />
                      </button>
                      {lead.headline ? (
                        <div
                          className="mt-1 max-w-[280px] truncate text-xs font-medium text-slate-500"
                          title={lead.headline}
                        >
                          {lead.headline}
                        </div>
                      ) : null}
                      {lead.decisionMakerName ? (
                        <div className="mt-2 max-w-[280px] rounded-xl border border-emerald-100 bg-emerald-50/70 px-2.5 py-2">
                          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-emerald-700">
                            Public person
                          </p>
                          <p className="mt-1 truncate text-xs font-bold text-emerald-950" title={lead.decisionMakerName}>
                            {lead.decisionMakerName}
                          </p>
                          {lead.decisionMakerRole ? (
                            <p className="mt-0.5 truncate text-[11px] text-emerald-800" title={lead.decisionMakerRole}>
                              {lead.decisionMakerRole}
                            </p>
                          ) : null}
                          {hasBusinessPhonePair ? (
                            <span
                              className="mt-1.5 inline-flex rounded-full bg-emerald-100 px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] text-emerald-800"
                              title="The public human name and the selected phone are supported by public evidence. The phone is a business route, not a personal-number claim."
                            >
                              Name + business phone
                            </span>
                          ) : null}
                        </div>
                      ) : !isLinkedInLead ? (
                        <p className="mt-2 text-[11px] font-semibold text-slate-400">
                          Public person not identified
                        </p>
                      ) : null}
                      <div><LeadQualityBadge lead={lead} /></div>
                      {isLinkedInLead ? (
                        <>
                          <div className="mt-2 flex flex-wrap items-center gap-2 text-[11px] font-semibold">
                            <span className="rounded-full bg-blue-50 px-2 py-1 text-blue-700">
                              Public match
                            </span>
                            <span className="rounded-full bg-slate-100 px-2 py-1 text-slate-600">
                              {matchLabel} · {lead.confidence}/100
                            </span>
                            {qualityTier ? (
                              <span
                                className={`rounded-full px-2 py-1 font-black ${
                                  qualityTier === 'A'
                                    ? 'bg-slate-950 text-white'
                                    : qualityTier === 'B'
                                      ? 'bg-blue-50 text-blue-700'
                                      : 'bg-slate-100 text-slate-600'
                                }`}
                                title="Research tier based on public category, role, location, and corroboration signals."
                              >
                                Tier {qualityTier}
                              </span>
                            ) : null}
                            {lead.matchSignals?.publicSources && lead.matchSignals.publicSources > 1 ? (
                              <span
                                className="rounded-full bg-emerald-50 px-2 py-1 text-emerald-700"
                                title={`${lead.matchSignals.queryMatches} public query matches across ${lead.matchSignals.publicProviderNames?.join(', ') || `${lead.matchSignals.publicSources} public sources`}`}
                              >
                                {lead.matchSignals.publicSources}-source signal
                              </span>
                            ) : null}
                            <span className="rounded-full bg-amber-50 px-2 py-1 text-amber-700">
                              {getLinkedInReadinessLabel(lead)}
                            </span>
                            {lead.employmentStatus ? (
                              <span
                                className={`rounded-full px-2 py-1 ${
                                  lead.employmentStatus === 'current'
                                    ? 'bg-emerald-50 text-emerald-700'
                                    : lead.employmentStatus === 'conflicting'
                                      ? 'bg-red-50 text-red-700'
                                      : 'bg-slate-100 text-slate-600'
                                }`}
                                title="Conservative status inferred from public search-result wording only."
                              >
                                {employmentStatusLabels[lead.employmentStatus]}
                              </span>
                            ) : null}
                          </div>
                          {lead.matchSignals ? (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] font-semibold text-slate-500">
                              {lead.matchSignals.roleMatched ? (
                                <span
                                  className="rounded-full border border-violet-100 bg-violet-50 px-2 py-1 text-violet-700"
                                  title="The public profile matched an expanded decision-maker role term."
                                >
                                  Role signal
                                </span>
                              ) : null}
                              {hasOwnerSignal ? (
                                <span
                                  className="rounded-full border border-sky-100 bg-sky-50 px-2 py-1 text-sky-700"
                                  title="The public profile matched an owner, founder, principal, or operating-head term."
                                >
                                  Owner signal
                                </span>
                              ) : null}
                              {lead.matchSignals.locationMatched ? (
                                <span
                                  className="rounded-full border border-amber-100 bg-amber-50 px-2 py-1 text-amber-700"
                                  title="The public result contained a matching city, state, or regional signal."
                                >
                                  Location signal
                                </span>
                              ) : null}
                              {lead.matchSignals.queryMatches > 0 ? (
                                <span
                                  className="rounded-full border border-slate-200 bg-white px-2 py-1 text-slate-600"
                                  title="Number of public query paths that matched this lead."
                                >
                                  {lead.matchSignals.queryMatches} query paths
                                </span>
                              ) : null}
                            </div>
                          ) : null}
                        </>
                      ) : null}
                    </td>
                    <td className="px-4 py-4">
                      <ContactCell publiclyObserved={lead.quality?.phone.publiclyObserved} verified={lead.verifiedPhone} value={lead.mobile} />
                    </td>
                    <td className="px-4 py-4">
                      <ContactCell publiclyObserved={lead.quality?.email.publiclyObserved} verified={lead.verifiedEmail} value={lead.email} />
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex min-w-[160px] flex-col gap-1.5">
                        {profileUrl ? (
                          <a
                            aria-label={`Open LinkedIn profile for ${lead.name}`}
                            className="font-semibold text-blue-700 hover:text-blue-800"
                            href={profileUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            LinkedIn profile
                          </a>
                        ) : null}
                        {websiteUrl ? (
                          <a
                            aria-label={`Open business website for ${lead.name}`}
                            className={isLinkedInLead ? 'text-xs text-slate-500 hover:text-blue-700' : 'text-blue-700 hover:text-blue-800'}
                            href={websiteUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {isLinkedInLead
                              ? 'Business website'
                              : websiteUrl.replace(/^https?:\/\//, '')}
                          </a>
                        ) : null}
                        {fallbackUrl ? (
                          <a
                            className="text-blue-700 hover:text-blue-800"
                            href={fallbackUrl}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {fallbackUrl.replace(/^https?:\/\//, '')}
                          </a>
                        ) : null}
                        {!profileUrl && !websiteUrl && !fallbackUrl ? '—' : null}
                      </div>
                    </td>
                    <td className="px-4 py-4 text-slate-600">
                      <span className="block max-w-[220px] truncate" title={lead.address || undefined}>
                        {lead.address || '—'}
                      </span>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex min-w-[170px] flex-col items-start gap-1.5">
                        {showSourceSequence ? (
                          <span
                            className={`rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-[0.08em] ${
                              sourcePriority === 1
                                ? 'bg-blue-100 text-blue-800'
                                : sourcePriority === 2
                                  ? 'bg-slate-100 text-slate-700'
                                  : sourcePriority === 3
                                    ? 'bg-violet-50 text-violet-700'
                                    : 'bg-emerald-50 text-emerald-700'
                            }`}
                            title={publicLeadSourceOrderLabels[sourceOrder]}
                          >
                            {sourceOrder} · {publicLeadSourceOrderLabels[sourceOrder]}
                          </span>
                        ) : null}
                        <span
                          className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            isLinkedInLead
                              ? 'bg-blue-50 text-blue-700'
                              : 'bg-emerald-50 text-emerald-700'
                          }`}
                        >
                          {lead.source}
                        </span>
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex gap-2">
                        <button
                          aria-label={`Copy lead details for ${lead.name}`}
                          className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-blue-200 hover:text-blue-700"
                          onClick={() => onCopyRow(lead)}
                          title="Copy lead details"
                          type="button"
                        >
                          <Copy className="h-4 w-4" />
                        </button>
                        <a
                          aria-label={`Open ${primaryActionLabel} for ${lead.name}`}
                          className="rounded-full border border-slate-200 p-2 text-slate-500 transition hover:border-blue-200 hover:text-blue-700"
                          href={primaryActionUrl || '#'}
                          onClick={(event) => {
                            if (!primaryActionUrl) event.preventDefault();
                          }}
                          rel="noreferrer"
                          title={`Open ${primaryActionLabel}`}
                          target="_blank"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                      </div>
                    </td>
                  </tr>
                  {isExpanded ? (
                    <tr className="border-t border-slate-100 bg-slate-50/70" id={`lead-details-${lead.id}`}>
                      <td className="px-4 py-5" colSpan={8}>
                        <div className="sticky left-4 w-[calc(100cqw-2rem)]">
                        <LeadQualityDetails lead={lead} />
                        <div className="mt-5 rounded-2xl border border-amber-100 bg-amber-50/60 p-4">
                          <div className="flex flex-wrap items-start justify-between gap-3">
                            <div>
                              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-amber-700">
                                Improve this workspace
                              </p>
                              <p className="mt-1 max-w-2xl text-xs leading-5 text-slate-600">
                                Flag a bad match or mark a useful lead. Feedback is saved only to your
                                signed-in workspace and never changes public source data.
                              </p>
                            </div>
                            <div className="flex flex-wrap gap-2">
                              {(
                                [
                                  ['wrong_phone', 'Wrong phone'],
                                  ['wrong_business', 'Wrong business'],
                                  ['wrong_person', 'Wrong person'],
                                  ['former_employee', 'Former person'],
                                  ['duplicate', 'Duplicate'],
                                  ['do_not_contact', 'Do not contact'],
                                  ['useful', 'Useful'],
                                ] as const
                              ).map(([eventType, label]) => (
                                <button
                                  className={`rounded-full border px-3 py-1.5 text-[11px] font-bold transition ${
                                    eventType === 'useful'
                                      ? 'border-emerald-200 bg-white text-emerald-700 hover:border-emerald-300'
                                      : 'border-amber-200 bg-white text-amber-800 hover:border-amber-300'
                                  }`}
                                  key={eventType}
                                  onClick={() => onFeedback(lead, eventType)}
                                  type="button"
                                >
                                  {label}
                                </button>
                              ))}
                            </div>
                          </div>
                        </div>
                        <div className="grid gap-5 lg:grid-cols-[1.15fr_0.85fr]">
                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                              Lead snapshot
                            </p>
                            <p className="mt-2 text-sm leading-5 text-slate-600">
                              {isLinkedInLead
                                ? 'Profile identity is public; contact fields come from public business sources. A business line does not establish a personal number.'
                                : 'Review the available business details before adding this lead to your export.'}
                            </p>
                            <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
                              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-700">
                                Public decision-maker
                              </p>
                              {lead.decisionMakerName ? (
                                <>
                                  <p className="mt-1 text-sm font-bold text-emerald-950">
                                    {lead.decisionMakerName}
                                  </p>
                                  {lead.decisionMakerRole ? (
                                    <p className="mt-0.5 text-xs text-emerald-800">
                                      {lead.decisionMakerRole}
                                    </p>
                                  ) : null}
                                  {lead.decisionMakerSourceUrl ? (
                                    <a
                                      className="mt-2 inline-block text-xs font-semibold text-emerald-700 underline underline-offset-2"
                                      href={lead.decisionMakerSourceUrl}
                                      rel="noreferrer"
                                      target="_blank"
                                    >
                                      Open public name source
                                    </a>
                                  ) : null}
                                </>
                              ) : (
                                <p className="mt-1 text-xs leading-5 text-slate-600">
                                  No current human name was found on the public sources checked. This
                                  does not mean the business has no owner or operator.
                                </p>
                              )}
                            </div>
                            <div className={`mt-3 rounded-xl border p-3 ${
                              hasBusinessPhonePair
                                ? 'border-emerald-200 bg-emerald-50/70'
                                : hasPublicPhonePair
                                  ? 'border-blue-100 bg-blue-50/70'
                                  : lead.decisionMakerPhonePair?.status === 'phone_only'
                                    ? 'border-amber-100 bg-amber-50/70'
                                    : 'border-slate-200 bg-white'
                            }`}>
                              <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                                Decision-maker + phone route
                              </p>
                              {hasBusinessPhonePair ? (
                                <>
                                  <p className="mt-1 text-xs font-bold text-emerald-950">
                                    {lead.decisionMakerName} · {lead.mobile}
                                  </p>
                                  <p className="mt-1 text-[11px] leading-4 text-emerald-800">
                                    Public name and public business phone align for this company. This is a
                                    business contact route, not a verified personal or direct line.
                                  </p>
                                </>
                              ) : hasPublicPhonePair ? (
                                <p className="mt-1 text-xs leading-5 text-blue-900">
                                  A public person and public phone were found, but the phone association is
                                  marked {lead.decisionMakerPhonePair?.phoneAssociation ?? 'unknown'}.
                                </p>
                              ) : lead.decisionMakerPhonePair?.status === 'phone_only' ? (
                                <p className="mt-1 text-xs leading-5 text-amber-900">
                                  {lead.mobile} is publicly listed, but no explicitly published human name
                                  was identified in the checked sources.
                                </p>
                              ) : (
                                <p className="mt-1 text-xs leading-5 text-slate-600">
                                  The checked public sources do not currently provide a verified name-and-phone
                                  pairing for this record.
                                </p>
                              )}
                              <div className="mt-2 flex flex-wrap gap-3 text-[11px] font-semibold">
                                {lead.decisionMakerPhonePair?.personSourceUrl ? (
                                  <a
                                    className="text-blue-700 underline underline-offset-2 hover:text-blue-900"
                                    href={lead.decisionMakerPhonePair.personSourceUrl}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    Name source
                                  </a>
                                ) : null}
                                {lead.decisionMakerPhonePair?.phoneSourceUrl ? (
                                  <a
                                    className="text-blue-700 underline underline-offset-2 hover:text-blue-900"
                                    href={lead.decisionMakerPhonePair.phoneSourceUrl}
                                    rel="noreferrer"
                                    target="_blank"
                                  >
                                    Phone source
                                  </a>
                                ) : null}
                              </div>
                            </div>
                            {lead.contactSourceUrl ? (
                              <p className="mt-3 text-xs leading-5 text-slate-500">
                                Public contact source:{' '}
                                <a
                                  className="font-semibold text-blue-700 hover:text-blue-800"
                                  href={lead.contactSourceUrl}
                                  rel="noreferrer"
                                  target="_blank"
                                >
                                  {lead.contactSourceUrl.replace(/^https?:\/\//, '')}
                                </a>
                              </p>
                            ) : null}
                            {lead.publicSocialLinks?.length ? (
                              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                                  Public social signals
                                </p>
                                <div className="mt-2 flex flex-wrap gap-2">
                                  {lead.publicSocialLinks.map((socialLink) => (
                                    <a
                                      className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-2.5 py-1.5 text-[11px] font-semibold text-blue-700 hover:border-blue-200 hover:text-blue-800"
                                      href={socialLink.url}
                                      key={socialLink.url}
                                      rel="noreferrer"
                                      target="_blank"
                                    >
                                      {socialLink.platform}
                                      <ExternalLink className="h-3 w-3" />
                                    </a>
                                  ))}
                                </div>
                                <p className="mt-2 text-[11px] leading-4 text-slate-500">
                                  Links published by the public business website. Social profiles were not
                                  accessed for private contact data.
                                </p>
                              </div>
                            ) : null}
                            {isLinkedInLead &&
                            (lead.publicEvidence?.profileTitle || lead.publicEvidence?.profileSnippet) ? (
                              <div className="mt-4 rounded-xl border border-blue-100 bg-blue-50/60 p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-blue-700">
                                  Public match excerpt
                                </p>
                                {lead.publicEvidence.profileTitle ? (
                                  <p className="mt-2 text-xs font-semibold leading-5 text-slate-800">
                                    {lead.publicEvidence.profileTitle}
                                  </p>
                                ) : null}
                                {lead.publicEvidence.profileSnippet ? (
                                  <p className="mt-1 text-xs leading-5 text-slate-600">
                                    {lead.publicEvidence.profileSnippet}
                                  </p>
                                ) : null}
                                <p className="mt-2 text-[11px] leading-4 text-slate-500">
                                  Excerpt from a public search result. Verify the linked profile before outreach.
                                </p>
                                {lead.publicEvidence.sources?.length ? (
                                  <div className="mt-3 flex flex-wrap items-center gap-2">
                                    <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-blue-700">
                                      {lead.publicEvidence.sources.length} public result{' '}
                                      {lead.publicEvidence.sources.length === 1 ? 'trace' : 'traces'}
                                    </span>
                                    {lead.publicEvidence.sources.map((source, index) => (
                                      <span
                                        className="rounded-full border border-blue-100 bg-white px-2 py-1 text-[11px] font-semibold text-slate-600"
                                        key={source.providerName + '-' + index}
                                      >
                                        {source.providerName}
                                      </span>
                                    ))}
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                            <div className="mt-4 grid gap-2 sm:grid-cols-3">
                              <div className="rounded-xl border border-slate-200 bg-white p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                                  Email
                                </p>
                                <p className="mt-1 truncate text-sm font-semibold text-slate-900">
                                  {lead.email || 'Not listed'}
                                </p>
                              </div>
                              <div className="rounded-xl border border-slate-200 bg-white p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                                  Phone
                                </p>
                                <p className="mt-1 text-sm font-semibold text-slate-900">
                                  {lead.mobile || 'Not listed'}
                                </p>
                              </div>
                              <div className="rounded-xl border border-slate-200 bg-white p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">
                                  Website
                                </p>
                                <p className="mt-1 truncate text-sm font-semibold text-slate-900">
                                  {lead.website ? 'Available' : 'Not listed'}
                                </p>
                              </div>
                            </div>
                          </div>

                          <div>
                            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-slate-400">
                              Match evidence
                            </p>
                            {lead.scores ? (
                              <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                                {(
                                  [
                                    ['Trust', lead.scores.trust],
                                    ['Fit', lead.scores.fit],
                                    ['Contact', lead.scores.contactability],
                                    ['Opportunity', lead.scores.opportunity],
                                    ['Priority', lead.scores.priority],
                                  ] as const
                                ).map(([label, value]) => (
                                  <div className="rounded-xl border border-slate-200 bg-white p-2.5" key={label}>
                                    <p className="text-[10px] font-bold uppercase tracking-[0.12em] text-slate-400">
                                      {label}
                                    </p>
                                    <p className="mt-1 text-lg font-black text-slate-950">{value}/100</p>
                                  </div>
                                ))}
                              </div>
                            ) : null}
                            {lead.scores?.reasons.length ? (
                              <div className="mt-3 flex flex-wrap gap-2">
                                {lead.scores.reasons.map((reason) => (
                                  <span
                                    className="rounded-full bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700"
                                    key={reason}
                                  >
                                    {reason}
                                  </span>
                                ))}
                              </div>
                            ) : null}
                            {lead.evidence?.length ? (
                              <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
                                <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-emerald-700">
                                  Source-backed claims
                                </p>
                                <div className="mt-2 space-y-2">
                                  {lead.evidence.slice(0, 6).map((evidence) => (
                                    <div className="text-xs leading-5 text-slate-700" key={`${evidence.sourceUrl}-${evidence.claim}`}>
                                      <span className="font-semibold">{evidence.claim}</span>{' '}
                                      <a
                                        className="text-emerald-700 underline decoration-emerald-300 underline-offset-2 hover:text-emerald-900"
                                        href={evidence.sourceUrl}
                                        rel="noreferrer"
                                        target="_blank"
                                      >
                                        ({evidence.sourceName})
                                      </a>
                                      <span className="ml-1 rounded-full bg-white px-1.5 py-0.5 text-[10px] font-bold uppercase text-emerald-700">
                                        {evidence.status}
                                      </span>
                                    </div>
                                  ))}
                                </div>
                              </div>
                            ) : null}
                            <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
                              <span className="rounded-full bg-white px-3 py-2 text-slate-700">
                                Match score {lead.confidence}/100
                              </span>
                              {isLinkedInLead ? (
                                <span className="rounded-full bg-slate-950 px-3 py-2 text-white">
                                  Research tier {getLinkedInQualityTier(lead)}
                                </span>
                              ) : null}
                              {isLinkedInLead && lead.matchSignals ? (
                                <>
                                  {lead.matchSignals.categoryMatched ? (
                                    <span className="rounded-full bg-blue-50 px-3 py-2 text-blue-700">
                                      Category: {lead.matchSignals.categoryMatchedTerms?.join(', ') || 'matched'}
                                    </span>
                                  ) : null}
                                  {lead.matchSignals.roleMatched ? (
                                    <span className="rounded-full bg-violet-50 px-3 py-2 text-violet-700">
                                      Role: {lead.matchSignals.roleMatchedTerms?.join(', ') || 'matched'}
                                    </span>
                                  ) : (
                                    <span className="rounded-full bg-violet-50 px-3 py-2 text-violet-700">
                                      Role not confirmed
                                    </span>
                                  )}
                                  {hasOwnerSignal ? (
                                    <span className="rounded-full bg-sky-50 px-3 py-2 text-sky-700">
                                      Owner/head: {lead.matchSignals.roleMatchedTerms?.join(', ') || 'matched'}
                                    </span>
                                  ) : null}
                                  {lead.matchSignals.locationMatched ? (
                                    <span className="rounded-full bg-amber-50 px-3 py-2 text-amber-700">
                                      Public location: {lead.matchSignals.locationEvidence || 'matched'}
                                    </span>
                                  ) : (
                                    <span className="rounded-full bg-amber-50 px-3 py-2 text-amber-700">
                                      Location not confirmed
                                    </span>
                                  )}
                                  <span className="rounded-full bg-emerald-50 px-3 py-2 text-emerald-700">
                                    {lead.matchSignals.queryMatches} query paths · {lead.matchSignals.publicSources} public sources
                                  </span>
                                  {lead.matchSignals.queryFamilies?.length ? (
                                    <span className="rounded-full bg-slate-100 px-3 py-2 text-slate-700">
                                      Lenses:{' '}
                                      {lead.matchSignals.queryFamilies
                                        .map((family) => queryFamilyLabels[family] ?? family)
                                        .join(', ')}
                                    </span>
                                  ) : null}
                                  <span className="rounded-full bg-blue-50 px-3 py-2 text-blue-700">
                                    {lead.matchSignals.publicProviderNames?.join(' + ') || 'Public search sources'}
                                  </span>
                                </>
                              ) : null}
                            </div>
                            <p className="mt-4 text-xs leading-5 text-slate-500">
                              Source: {lead.source}. Verify the linked website or public profile before outreach.
                            </p>
                          </div>
                        </div>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
            {!leads.length ? (
              <tr>
                <td className="px-4 py-10 text-center text-sm text-slate-500" colSpan={8}>
                  {emptyStateMessage}
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
