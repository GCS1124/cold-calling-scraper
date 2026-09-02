import request from 'supertest';
import { describe, expect, it } from 'vitest';

import { createApp } from '../app';

describe('createApp', () => {
  it('serves health checks without loading the discovery orchestrator', async () => {
    const response = await request(createApp()).get('/api/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ status: 'ok' });
  });
});
