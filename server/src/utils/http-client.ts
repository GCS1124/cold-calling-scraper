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
  // Public APIs and Overpass are untrusted inputs. Keep Axios from buffering
  // an unexpectedly large response or request body before the caller can
  // apply its own provider-specific limits.
  maxContentLength: 8_000_000,
  maxBodyLength: 2_000_000,
  transitional: {
    clarifyTimeoutError: true,
  },
});
