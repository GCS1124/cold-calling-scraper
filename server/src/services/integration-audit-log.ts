import {
  getSearchDatabasePool,
  hasSearchDatabase,
  SearchPersistenceError,
} from './search-job-store';

export type IntegrationAuditOutcome = 'completed' | 'failed' | 'rejected';

export type IntegrationAuditEvent = {
  requestId: string;
  ownerId?: string;
  apiKeyId?: string;
  method: string;
  path: string;
  operation: string;
  outcome: IntegrationAuditOutcome;
  statusCode?: number;
  errorCode?: string;
  createdAt?: Date;
};

type IntegrationAuditMode = 'off' | 'best-effort' | 'required';

const MAX_FIELD_LENGTH = 256;
const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3_650;
const PRUNE_INTERVAL_MS = 15 * 60 * 1_000;

let lastPrunedAt = 0;

const normalizeField = (value: string | undefined, fallback = '') =>
  value?.trim().slice(0, MAX_FIELD_LENGTH) || fallback;

const normalizeMode = (value: string | undefined): IntegrationAuditMode => {
  const normalized = value?.trim().toLowerCase();
  return normalized === 'off' || normalized === 'required' ? normalized : 'best-effort';
};

const getAuditMode = () =>
  normalizeMode(process.env.LEAD_FINDER_INTEGRATION_AUDIT_MODE);

const getRetentionDays = () => {
  const parsed = Number(process.env.LEAD_FINDER_INTEGRATION_AUDIT_RETENTION_DAYS);
  if (!Number.isFinite(parsed)) return DEFAULT_RETENTION_DAYS;
  return Math.min(MAX_RETENTION_DAYS, Math.max(MIN_RETENTION_DAYS, Math.floor(parsed)));
};

export const isIntegrationAuditRequired = () => getAuditMode() === 'required';

export const ensureIntegrationAuditReady = async () => {
  if (getAuditMode() !== 'required') return;

  if (!hasSearchDatabase()) {
    throw new SearchPersistenceError(
      'Required integration audit logging is not configured. Add a Postgres connection string and apply the audit migration.',
    );
  }

  const pool = getSearchDatabasePool();
  if (!pool) {
    throw new SearchPersistenceError(
      'Required integration audit logging is temporarily unavailable.',
    );
  }

  try {
    await pool.query('select 1 from public.integration_audit_events limit 0');
  } catch (error) {
    console.error('[integration-audit] readiness check failed', error);
    throw new SearchPersistenceError(
      'Required integration audit logging is temporarily unavailable. Apply the audit migration and try again.',
    );
  }
};

const pruneExpiredEvents = async () => {
  if (!hasSearchDatabase()) return;

  const pool = getSearchDatabasePool();
  if (!pool) return;

  const now = Date.now();
  if (now - lastPrunedAt < PRUNE_INTERVAL_MS) return;
  lastPrunedAt = now;

  try {
    await pool.query(
      `delete from public.integration_audit_events
       where created_at < now() - ($1::text || ' days')::interval`,
      [String(getRetentionDays())],
    );
  } catch (error) {
    console.error('[integration-audit] retention cleanup failed', error);
  }
};

export const recordIntegrationAuditEvent = async (event: IntegrationAuditEvent) => {
  const mode = getAuditMode();
  if (mode === 'off') return;

  if (!hasSearchDatabase()) {
    if (mode === 'required') {
      throw new SearchPersistenceError(
        'Required integration audit logging is not configured. Add a Postgres connection string and apply the audit migration.',
      );
    }
    return;
  }

  const pool = getSearchDatabasePool();
  if (!pool) {
    if (mode === 'required') {
      throw new SearchPersistenceError(
        'Required integration audit logging is temporarily unavailable.',
      );
    }
    return;
  }

  const requestId = normalizeField(event.requestId, 'unknown');
  const method = normalizeField(event.method.toUpperCase(), 'UNKNOWN');
  const path = normalizeField(event.path.split(/[?#]/, 1)[0], '/api/v1');
  const operation = normalizeField(event.operation, `${method} ${path}`);
  const ownerId = normalizeField(event.ownerId) || null;
  const apiKeyId = normalizeField(event.apiKeyId) || null;
  const errorCode = normalizeField(event.errorCode) || null;
  const statusCode = Number.isInteger(event.statusCode) ? event.statusCode : null;

  try {
    await pool.query(
      `insert into public.integration_audit_events
        (request_id, owner_id, api_key_id, method, path, operation, outcome, status_code, error_code, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, coalesce($10::timestamptz, now()))`,
      [
        requestId,
        ownerId,
        apiKeyId,
        method,
        path,
        operation,
        event.outcome,
        statusCode,
        errorCode,
        event.createdAt?.toISOString() ?? null,
      ],
    );
  } catch (error) {
    console.error('[integration-audit] event write failed', error);
    if (mode === 'required') {
      throw new SearchPersistenceError(
        'Required integration audit logging is temporarily unavailable.',
      );
    }
    return;
  }

  void pruneExpiredEvents();
};
