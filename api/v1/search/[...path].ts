import cancelHandler from '../../search/[id]/cancel.js';
import evidenceHandler from '../../search/[id]/evidence.js';
import feedbackHandler from '../../search/[id]/feedback.js';
import resumeHandler from '../../search/[id]/resume.js';
import reverifyHandler from '../../search/[id]/reverify.js';
import snapshotHandler from '../../search/[id].js';
import { getRequestId, sendSearchError } from '../../../server/src/http/search-http-contract.js';
import { requireIntegrationOwner } from '../../_lib/integration-handler.js';

type VercelHandler = (request: any, response: any) => unknown;

const actionHandlers: Record<string, VercelHandler> = {
  cancel: cancelHandler,
  evidence: evidenceHandler,
  feedback: feedbackHandler,
  resume: resumeHandler,
  reverify: reverifyHandler,
};

const getPathSegments = (request: any) => {
  const value = request.query?.path;
  const rawSegments = Array.isArray(value)
    ? value
    : typeof value === 'string'
      ? value.split('/')
      : [];
  return rawSegments.filter(
    (segment): segment is string => typeof segment === 'string' && Boolean(segment),
  );
};

export default requireIntegrationOwner(async (request, response) => {
  const segments = getPathSegments(request);
  const [searchId, action] = segments;
  const handler =
    segments.length === 1
      ? snapshotHandler
      : segments.length === 2 && action
        ? actionHandlers[action]
        : undefined;

  if (!searchId || !handler) {
    const requestId = getRequestId(request);
    sendSearchError(response, 404, {
      code: 'INTEGRATION_ROUTE_NOT_FOUND',
      message: 'Integration search route not found',
      retryable: false,
      requestId,
    });
    return;
  }

  return handler(request, response);
});
