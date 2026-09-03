import type { Pool, PoolClient, QueryResultRow } from 'pg';

import type { Lead } from '../types/lead';
import type { SearchJobRecord } from './search-job-store';

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

const sourceFamilyFor = (name: string, url: string) => {
  if (/linkedin/i.test(name) || /linkedin\.com/i.test(url)) return 'linkedin';
  if (/google|gmb|maps/i.test(name) || /google\.com\/maps/i.test(url)) return 'business-listing';
  if (/openstreetmap|osm/i.test(name) || /openstreetmap\.org/i.test(url)) return 'open-map';
  if (/social|facebook|instagram|youtube|tiktok|twitter|x\.com/i.test(name)) return 'social';
  return 'public-website';
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

  return `organization:${[
    normalizeKeyPart(lead.name),
    normalizeKeyPart(lead.city),
    normalizeKeyPart(lead.stateCode || lead.state),
    normalizeKeyPart(websiteHost),
  ].join('|')}`.slice(0, 480);
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
      sourceFamilyFor(lead.source, url),
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

const upsertOrganization = async (runner: QueryRunner, lead: Lead) => {
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
      lead.name,
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
) => {
  if (!value.trim()) return;

  await runner.query(
    `
      insert into research_contact_points (
        search_id, entity_key, kind, value, normalized_value, status, source_document_id
      ) values ($1, $2, $3, $4, $5, $6, $7)
      on conflict (search_id, entity_key, kind, normalized_value) do update set
        value = excluded.value,
        status = excluded.status,
        source_document_id = coalesce(excluded.source_document_id, research_contact_points.source_document_id),
        observed_at = now()
    `,
    [
      job.searchId,
      entityKey,
      kind,
      value.trim(),
      normalizeKeyPart(value),
      status,
      document?.id ?? null,
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
) => {
  await runner.query(
    `
      insert into research_verification_events (
        search_id, entity_key, field_name, result, source_document_id, metadata
      ) values ($1, $2, $3, $4, $5, $6::jsonb)
    `,
    [job.searchId, entityKey, fieldName, result, document?.id ?? null, JSON.stringify(metadata)],
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
    await upsertPerson(runner, lead);
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
    );
  }

  if (lead.website) {
    await insertContactPoint(runner, job, entityKey, 'website', lead.website, 'public', primaryDocument);
  }

  for (const social of lead.publicSocialLinks ?? []) {
    await insertContactPoint(runner, job, entityKey, 'social', social.url, 'public', primaryDocument);
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
    await runner.query(
      `
        delete from research_claim_evidence evidence
        using research_claims claims
        where evidence.claim_id = claims.id and claims.search_id = $1;
        delete from research_claims where search_id = $1;
        delete from research_contact_points where search_id = $1;
        delete from research_verification_events where search_id = $1;
        delete from research_opportunity_signals where search_id = $1;
        delete from research_job_steps where search_id = $1 and step_key = 'normalized-persistence';
      `,
      [job.searchId],
    );

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
