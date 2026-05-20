import http from 'node:http';
import https from 'node:https';

import axios from 'axios';

const agentOptions = {
  keepAlive: false,
  maxSockets: 6,
  maxFreeSockets: 2,
};

export const httpAgent = new http.Agent(agentOptions);
export const httpsAgent = new https.Agent(agentOptions);

export const httpClient = axios.create({
  httpAgent,
  httpsAgent,
  maxRedirects: 5,
  transitional: {
    clarifyTimeoutError: true,
  },
});
