import { getSearchJobSnapshot } from '../../../server/src/services/search-job-snapshot.js';
import { buildResearchDossier } from '../../../server/src/services/research-dossier.js';
import {
  getRequestId,
  sendSearchError,
  setRequestIdHeader,
} from '../../../server/src/http/search-http-contract.js';
import { authorizeSearchRequest } from '../../_lib/search-auth.js';

export default async function handler(req: any, res: any) {
  const requestId = getRequestId(req);
  setRequestIdHeader(res, requestId);

  if (req.method !== 'GET') {
    sendSearchError(res, 405, {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed',
      retryable: false,
      requestId,
    });
    return;
  }

  const searchId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const requestedLeadId = Array.isArray(req.query.leadId)
    ? req.query.leadId[0]
    : req.query.leadId;

  if (!searchId) {
    sendSearchError(res, 400, {
      code: 'MISSING_SEARCH_ID',
      message: 'Missing search id',
      retryable: false,
      requestId,
    });
    return;
  }

  try {
    const auth = await authorizeSearchRequest(req, res, requestId);
    if (!auth) {
      return;
    }

    const response = auth.ownerId
      ? await getSearchJobSnapshot(searchId, { ownerId: auth.ownerId })
      : await getSearchJobSnapshot(searchId);
    if (!response) {
      sendSearchError(res, 404, {
        code: 'SEARCH_NOT_FOUND',
        message: 'Search not found or already expired',
        retryable: false,
        requestId,
      });
      return;
    }

    const dossier = buildResearchDossier(response, requestedLeadId);
    if (requestedLeadId && dossier.leads.length === 0) {
      sendSearchError(res, 404, {
        code: 'LEAD_NOT_FOUND',
        message: 'Lead not found in this search',
        retryable: false,
        requestId,
      });
      return;
    }

    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    res.status(200).json({ ...dossier, requestId });
  } catch (error) {
    sendSearchError(res, 500, {
      code: 'EVIDENCE_LOAD_FAILED',
      message: error instanceof Error ? error.message : 'Unable to load research evidence',
      retryable: true,
      requestId,
    });
  }
}
