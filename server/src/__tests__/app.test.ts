import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app';

describe('createApp', () => {
  it('serves health checks without loading the discovery orchestrator', async () => {
    const response = await request(createApp()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });

  it('exposes integration capabilities and keeps versioned search owner-scoped', async () => {
    const capabilities = await request(createApp()).get('/api/v1/capabilities');

    expect(capabilities.status).toBe(200);
    expect(capabilities.body).toMatchObject({
      apiVersion: 'v1',
      responseContractVersion: 2,
      authentication: { ownerRequired: true },
      modes: [
        { id: 'gmb' },
        {
          id: 'ai',
          name: 'AI mode: public-source fusion',
          contract: {
            meta: {
              sourceMode: 'ai',
              limitations: expect.arrayContaining([
                expect.stringContaining('including LinkedIn result signals'),
              ]),
            },
          },
        },
      ],
    });
    expect(capabilities.body.modes.map((mode: { id: string }) => mode.id)).toEqual(['gmb', 'ai']);

    const search = await request(createApp()).post('/api/v1/search').send({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
    });

    expect(search.status).toBe(401);
    expect(search.body).toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('returns the JSON error contract for malformed request bodies', async () => {
    const response = await request(createApp())
      .post('/api/search')
      .set('content-type', 'application/json')
      .send('{"companyType":');

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      code: 'INVALID_JSON_BODY',
      retryable: false,
      requestId: expect.any(String),
    });
    expect(response.headers['content-type']).toMatch(/application\/json/);
  });

  it('rejects oversized JSON before route processing', async () => {
    const response = await request(createApp())
      .post('/api/search')
      .set('content-type', 'application/json')
      .send(JSON.stringify({
        companyType: 'Dentist',
        location: { mode: 'timezone', timeZone: 'EST' },
        count: 50,
        researchBrief: 'x'.repeat(70_000),
      }));

    expect(response.status).toBe(413);
    expect(response.body).toMatchObject({
      code: 'REQUEST_BODY_TOO_LARGE',
      retryable: false,
      requestId: expect.any(String),
    });
  });
});
