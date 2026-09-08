import { buildIntegrationCapabilities } from '../../shared/integration-contract.js';
import { buildIntegrationOpenApi } from '../../shared/integration-openapi.js';
import {
  getRequestId,
  sendSearchError,
  setRequestIdHeader,
} from '../../server/src/http/search-http-contract.js';

export default function handler(req: any, res: any) {
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

  res.setHeader?.('Cache-Control', 'public, max-age=60, s-maxage=60');
  const format = Array.isArray(req.query?.format)
    ? req.query.format[0]
    : req.query?.format;
  if (format === 'openapi') {
    res.status(200).json(buildIntegrationOpenApi());
    return;
  }

  res.status(200).json({ ...buildIntegrationCapabilities(), requestId });
}
