import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type { Lead } from '../types/lead';
import type { SearchJobRecord } from './search-job-store';
import { samePublicHost, sourceFamilyForEvidence } from './source-evidence';

type QueryRunner = {
  query: <T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<{ rows: T[] }>;
};

type SourceDocument = {
  id: string;
  url: string;
  name: string;
  family: string;
};

const normalizeKeyPart = (value: string | undefined) =>
  (value ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .slice(0, 240);

const isHttpUrl = (value: string | undefined): value is string => {
  if (!value?.trim()) return false;

  try {
    const url = new URL(value.trim());
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
};

const isLinkedInPerson = (lead: Lead) =>
  /linkedin\.com\/(?:in|pub)\//i.test(lead.listingUrl ?? '');

const sourceFamilyFor = (lead: Lead, name: string, url: string) => {
  const isWebsiteDocument =
    url === lead.website ||
    url === lead.contactSourceUrl ||
    samePublicHost(url, lead.website);
  const officialWebsite =
    isWebsiteDocument &&
    ['confirmed', 'probable'].includes(lead.websiteAssessment?.status ?? '')
      ? true
      : undefined;

  return sourceFamilyForEvidence({
    sourceUrl: url,
    sourceName: name,
    sourceKind: isWebsiteDocument ? 'business_website' : undefined,
    officialWebsite,
  });
};

const sourceNameFor = (lead: Lead, url: string) => {
  if (url === lead.website) return 'Public website';
  if (url === lead.contactSourceUrl) return 'Public website contact page';
  if (url === lead.listingUrl) return lead.source || 'Public listing';
  return 'Public evidence';
};

const sourceUrlsFor = (lead: Lead) => {
  const urls = [
    lead.listingUrl,
    lead.website,
    lead.contactSourceUrl,
    ...(lead.evidence ?? []).map((evidence) => evidence.sourceUrl),
    ...(lead.publicSocialLinks ?? []).map((social) => social.url),
  ];

  return [...new Set(urls.filter(isHttpUrl))];
};

const organizationKeyFor = (lead: Lead) => {
  let websiteHost = '';

  try {
    websiteHost = lead.website ? new URL(lead.website).hostname : '';
  } catch {
    websiteHost = '';
  }

  const organizationName = lead.organizationName?.trim() || lead.name;

  return `organization:${[
    normalizeKeyPart(organizationName),
    normalizeKeyPart(lead.city),
    normalizeKeyPart(lead.stateCode || lead.state),
    normalizeKeyPart(websiteHost),
  ].join('|')}`.slice(0, 480);
};

const organizationNameFromHeadline = (headline?: string) => {
  const normalized = headline?.replace(/\s+/g, ' ').trim() ?? '';
  const match = normalized.match(
    /\b(?:at|@|with|for|of|owner of|founder of|principal of)\s+(.+?)(?:\s*[|•·].*)?$/i,
  );

  return (match?.[1] ?? '')
    .replace(/\s*[-|].*$/g, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .trim();
};

const organizationNameFor = (lead: Lead) => {
  const explicit = lead.organizationName?.trim();
  if (explicit && explicit.length >= 3) return explicit;

  const inferred = organizationNameFromHeadline(lead.headline);
  if (inferred && inferred.length >= 3) return inferred;

  return '';
};

const personKeyFor = (lead: Lead) =>
  `person:${[
    normalizeKeyPart(lead.name),
    normalizeKeyPart(lead.listingUrl),
  ].join('|')}`.slice(0, 480);

const statusForEmployment = (status: Lead['employmentStatus']) => {
  if (status === 'current') return 'confirmed';
  if (status === 'probable') return 'inferred';
  if (status === 'former') return 'stale';
  if (status === 'conflicting') return 'conflicting';
  return 'unknown';
};

const relationshipStatusFor = (status: Lead['employmentStatus']) => {
  if (status === 'current') return 'current';
  if (status === 'probable') return 'probable';
  if (status === 'former') return 'former';
  if (status === 'conflicting') return 'conflicting';
  return 'unverified';
};

const insertSourceDocument = async (
  runner: QueryRunner,
  job: SearchJobRecord,
  lead: Lead,
  url: string,
): Promise<SourceDocument | null> => {
  const result = await runner.query<SourceDocument>(
    `
      insert into research_source_documents (
        search_id, source_url, source_name, source_family,
        observed_at, authority_tier, metadata
      ) values ($1, $2, $3, $4, $5, $6, $7::jsonb)
      on conflict (search_id, source_url) do update set
        source_name = excluded.source_name,
        source_family = excluded.source_family,
        observed_at = excluded.observed_at,
        authority_tier = excluded.authority_tier,
        metadata = excluded.metadata
      returning id, source_url as url, source_name as name, source_family as family
    `,
    [
      job.searchId,
      url,
      sourceNameFor(lead, url),
      sourceFamilyFor(lead, sourceNameFor(lead, url), url),
      lead.scrapedAt,
      isLinkedInPerson(lead) ? 'public-search' : 'public-business-source',
      JSON.stringify({
        source: lead.source,
        category: lead.category,
        location: lead.city,
      }),
    ],
  );

  return result.rows[0] ?? null;
};

const upsertOrganization = async (
  runner: QueryRunner,
  lead: Lead,
  organizationName = lead.organizationName?.trim() || lead.name,
) => {
  const result = await runner.query<{ id: string }>(
    `
      insert into research_organizations (
        canonical_key, name, category, city, state_code, website, listing_url
      ) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (canonical_key) do update set
        name = excluded.name,
        category = excluded.category,
        city = excluded.city,
        state_code = excluded.state_code,
        website = coalesce(nullif(excluded.website, ''), research_organizations.website),
        listing_url = coalesce(nullif(excluded.listing_url, ''), research_organizations.listing_url),
        updated_at = now()
      returning id
    `,
    [
      organizationKeyFor(lead),
      organizationName,
      lead.category,
      lead.city,
      lead.stateCode || null,
      lead.website || '',
      lead.listingUrl || '',
    ],
  );

  return result.rows[0]?.id ?? null;
};

const upsertPerson = async (runner: QueryRunner, lead: Lead) => {
  const result = await runner.query<{ id: string }>(
    `
      insert into research_people (
        canonical_key, full_name, headline, linkedin_url, employment_status
      ) values ($1, $2, $3, $4, $5)
      on conflict (canonical_key) do update set
        full_name = excluded.full_name,
        headline = coalesce(nullif(excluded.headline, ''), research_people.headline),
        linkedin_url = coalesce(nullif(excluded.linkedin_url, ''), research_people.linkedin_url),
        employment_status = excluded.employment_status,
        updated_at = now()
      returning id
    `,
    [
      personKeyFor(lead),
      lead.name,
      lead.headline || '',
      lead.listingUrl || '',
      lead.employmentStatus || 'unverified',
    ],
  );

  return result.rows[0]?.id ?? null;
};

const insertClaim = async (
  runner: QueryRunner,
  job: SearchJobRecord,
  entityType: 'organization' | 'person' | 'contact' | 'opportunity',
  entityKey: string,
  claimType: string,
  claimValue: Record<string, unknown>,
  status: string,
  documents: SourceDocument[],
) => {
  const result = await runner.query<{ id: string }>(
    `
      insert into research_claims (
        search_id, entity_type, entity_key, claim_type, claim_value, status
      ) values ($1, $2, $3, $4, $5::jsonb, $6)
      returning id
    `,
    [job.searchId, entityType, entityKey, claimType, JSON.stringify(claimValue), status],
  );

  const claimId = result.rows[0]?.id;
  if (!claimId) return;

  for (const document of documents) {
    await runner.query(
      `
        insert into research_claim_evidence (
          claim_id, source_document_id, excerpt, supports
        ) values ($1, $2, $3, true)
        on conflict (claim_id, source_document_id) do update set
          excerpt = excluded.excerpt,
          supports = excluded.supports
      `,
      [claimId, document.id, claimValue.excerpt ?? null],
    );
  }
};

const insertContactPoint = async (
  runner: QueryRunner,
  job: SearchJobRecord,
  entityKey: string,
  kind: 'mobile' | 'phone' | 'email' | 'website' | 'social',
  value: string,
  status: 'public' | 'validated' | 'invalid' | 'unknown' | 'suppressed',
  document: SourceDocument | undefined,
  observedAt?: string,
) => {
  if (!value.trim()) return;

  await runner.query(
    `
      insert into research_contact_points (
        search_id, entity_key, kind, value, normalized_value, status, source_document_id, observed_at
      ) values ($1, $2, $3, $4, $5, $6, $7, coalesce($8::timestamptz, now()))
      on conflict (search_id, entity_key, kind, normalized_value) do update set
        value = excluded.value,
        status = excluded.status,
        source_document_id = coalesce(excluded.source_document_id, research_contact_points.source_document_id),
        observed_at = greatest(research_contact_points.observed_at, excluded.observed_at)
    `,
    [
      job.searchId,
      entityKey,
      kind,
      value.trim(),
      normalizeKeyPart(value),
      status,
      document?.id ?? null,
      observedAt || null,
    ],
  );
};

const insertVerificationEvent = async (
  runner: QueryRunner,
  job: SearchJobRecord,
  entityKey: string,
  fieldName: string,
  result: string,
  document: SourceDocument | undefined,
  metadata: Record<string, unknown> = {},
  valueKey = '',
) => {
  const idempotencyKey = [
    entityKey,
    fieldName,
    result,
    document?.id ?? '',
    normalizeKeyPart(valueKey),
  ].join('|').slice(0, 900);

  await runner.query(
    `
      insert into research_verification_events (
        search_id, entity_key, field_name, result, source_document_id, metadata, idempotency_key
      ) values ($1, $2, $3, $4, $5, $6::jsonb, $7)
      on conflict (search_id, idempotency_key) do update set
        result = excluded.result,
        source_document_id = coalesce(excluded.source_document_id, research_verification_events.source_document_id),
        metadata = excluded.metadata
    `,
    [
      job.searchId,
      entityKey,
      fieldName,
      result,
      document?.id ?? null,
      JSON.stringify(metadata),
      idempotencyKey,
    ],
  );
};

const materializeLead = async (
  runner: QueryRunner,
  job: SearchJobRecord,
  lead: Lead,
  documents: SourceDocument[],
) => {
  const person = isLinkedInPerson(lead);
  const entityKey = person ? personKeyFor(lead) : organizationKeyFor(lead);
  const primaryDocument = documents[0];

  if (person) {
    const personId = await upsertPerson(runner, lead);
    const organizationName = organizationNameFor(lead);
    let organizationId: string | null = null;

    if (organizationName) {
      organizationId = await upsertOrganization(
        runner,
        {
          ...lead,
          name: organizationName,
          organizationName: undefined,
          listingUrl: undefined,
        },
        organizationName,
      );
    }

    if (organizationId && personId) {
      await runner.query(
        `
          insert into research_organization_people (
            organization_id, person_id, role_title, relationship_status,
            source_document_id, observed_at
          ) values ($1, $2, $3, $4, $5, $6::timestamptz)
          on conflict (organization_id, person_id) do update set
            role_title = coalesce(nullif(excluded.role_title, ''), research_organization_people.role_title),
            relationship_status = excluded.relationship_status,
            source_document_id = coalesce(excluded.source_document_id, research_organization_people.source_document_id),
            observed_at = greatest(research_organization_people.observed_at, excluded.observed_at)
        `,
        [
          organizationId,
          personId,
          lead.originalRole || lead.headline || '',
          relationshipStatusFor(lead.employmentStatus),
          primaryDocument?.id ?? null,
          lead.scrapedAt || null,
        ],
      );
    }

    await insertClaim(
      runner,
      job,
      'person',
      entityKey,
      'public_identity',
      {
        name: lead.name,
        headline: lead.headline || null,
        profileUrl: lead.listingUrl || null,
        excerpt: lead.publicEvidence?.profileSnippet || null,
      },
      'confirmed',
      documents,
    );

    if (organizationName) {
      await insertClaim(
        runner,
        job,
        'person',
        entityKey,
        'organization_relationship',
        {
          organizationName,
          role: lead.normalizedRole || lead.originalRole || lead.headline || null,
          excerpt: lead.publicEvidence?.profileSnippet || null,
        },
        statusForEmployment(lead.employmentStatus),
        documents,
      );
    }

    if (lead.employmentStatus) {
      await insertClaim(
        runner,
        job,
        'person',
        entityKey,
        'employment_status',
        { value: lead.employmentStatus, excerpt: lead.publicEvidence?.profileSnippet || null },
        statusForEmployment(lead.employmentStatus),
        documents,
      );
    }
  } else {
    await upsertOrganization(runner, lead);
    await insertClaim(
      runner,
      job,
      'organization',
      entityKey,
      'public_business_identity',
      {
        name: lead.name,
        category: lead.category,
        city: lead.city,
        stateCode: lead.stateCode || null,
        excerpt: lead.evidence?.[0]?.claim || null,
      },
      'confirmed',
      documents,
    );
  }

  if (lead.mobile) {
    await insertContactPoint(
      runner,
      job,
      entityKey,
      'phone',
      lead.mobile,
      lead.hasPhone && lead.verifiedPhone ? 'validated' : 'unknown',
      documents.find((document) => document.url === lead.contactSourceUrl) || primaryDocument,
      lead.scrapedAt,
    );
  }

  if (lead.email) {
    await insertContactPoint(
      runner,
      job,
      entityKey,
      'email',
      lead.email,
      lead.hasEmail && lead.verifiedEmail ? 'validated' : 'public',
      documents.find((document) => document.url === lead.contactSourceUrl) || primaryDocument,
      lead.scrapedAt,
    );
  }

  if (lead.website) {
    await insertContactPoint(
      runner,
      job,
      entityKey,
      'website',
      lead.website,
      'public',
      primaryDocument,
      lead.scrapedAt,
    );
  }

  for (const social of lead.publicSocialLinks ?? []) {
    await insertContactPoint(
      runner,
      job,
      entityKey,
      'social',
      social.url,
      'public',
      primaryDocument,
      lead.scrapedAt,
    );
  }

  if (lead.mobile) {
    await insertVerificationEvent(
      runner,
      job,
      entityKey,
      'phone',
      lead.hasPhone && lead.verifiedPhone ? 'validated_public_format' : 'not_validated',
      documents.find((document) => document.url === lead.contactSourceUrl) || primaryDocument,
      { carrierTypeChecked: false },
      lead.mobile,
    );
  }

  if (lead.email) {
    await insertVerificationEvent(
      runner,
      job,
      entityKey,
      'email',
      lead.hasEmail && lead.verifiedEmail ? 'validated_public_format' : 'not_validated',
      documents.find((document) => document.url === lead.contactSourceUrl) || primaryDocument,
      {},
      lead.email,
    );
  }

  for (const signal of lead.opportunitySignals ?? []) {
    const result = await runner.query<{ id: string }>(
      `
        insert into research_opportunity_signals (
          search_id, entity_key, signal_type, label, source_document_id, confidence
        ) values ($1, $2, $3, $4, $5, $6)
        returning id
      `,
      [job.searchId, entityKey, 'public_website_signal', signal, primaryDocument?.id ?? null, 60],
    );

    if (result.rows[0]?.id) {
      await insertClaim(
        runner,
        job,
        'opportunity',
        entityKey,
        'opportunity_signal',
        { signal },
        'inferred',
        primaryDocument ? [primaryDocument] : [],
      );
    }
  }

  await runner.query(
    `
      insert into research_lead_snapshots (search_id, entity_key, snapshot)
      values ($1, $2, $3::jsonb)
      on conflict (search_id, entity_key) do update set
        snapshot = excluded.snapshot,
        captured_at = now()
    `,
    [job.searchId, entityKey, JSON.stringify(lead)],
  );
};

const runNormalizedPersistence = async (runner: QueryRunner, job: SearchJobRecord) => {
  await runner.query('begin');

  try {
    // node-postgres rejects multiple parameterized commands in one prepared
    // statement. Keep each cleanup query separate while retaining the single
    // transaction so retries still replace the normalized view atomically.
    const cleanupQueries = [
      `
        delete from research_claim_evidence evidence
        using research_claims claims
        where evidence.claim_id = claims.id and claims.search_id = $1
      `,
      'delete from research_claims where search_id = $1',
      'delete from research_contact_points where search_id = $1',
      'delete from research_verification_events where search_id = $1',
      'delete from research_opportunity_signals where search_id = $1',
      "delete from research_job_steps where search_id = $1 and step_key = 'normalized-persistence'",
    ];

    for (const query of cleanupQueries) {
      await runner.query(query, [job.searchId]);
    }

    const stepStatus = job.status === 'cancelled' ? 'cancelled' : 'complete';
    await runner.query(
      `
        insert into research_job_steps (
          search_id, step_key, status, attempt, started_at, finished_at, metadata
        ) values ($1, 'normalized-persistence', $2, 1, now(), now(), $3::jsonb)
        on conflict (search_id, step_key, attempt) do update set
          status = excluded.status,
          finished_at = excluded.finished_at,
          metadata = excluded.metadata
      `,
      [job.searchId, stepStatus, JSON.stringify({ leadCount: job.leads.length })],
    );

    for (const lead of job.leads) {
      const documents: SourceDocument[] = [];
      for (const url of sourceUrlsFor(lead)) {
        const document = await insertSourceDocument(runner, job, lead, url);
        if (document) documents.push(document);
      }

      await materializeLead(runner, job, lead, documents);
    }

    await runner.query('commit');
  } catch (error) {
    await runner.query('rollback').catch(() => undefined);
    throw error;
  }
};

export const persistNormalizedResearch = async (pool: Pool, job: SearchJobRecord) => {
  if (!['complete', 'failed', 'cancelled'].includes(job.status)) return;

  const poolWithConnect = pool as Pool & {
    connect?: () => Promise<PoolClient>;
  };

  if (typeof poolWithConnect.connect === 'function') {
    const client = await poolWithConnect.connect();
    try {
      await runNormalizedPersistence(client, job);
    } finally {
      client.release();
    }
    return;
  }

  await runNormalizedPersistence(pool, job);
};
