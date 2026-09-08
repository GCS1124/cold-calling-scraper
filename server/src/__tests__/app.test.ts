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
        { id: 'linkedin' },
        { id: 'ai' },
      ],
    });

    const search = await request(createApp()).post('/api/v1/search').send({
      companyType: 'Dentist',
      city: 'Austin, TX',
      count: 50,
    });

    expect(search.status).toBe(401);
    expect(search.body).toMatchObject({ code: 'AUTH_REQUIRED' });
  });
});
