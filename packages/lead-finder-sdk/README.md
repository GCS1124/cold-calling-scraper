# Lead Finder Integration SDK

The SDK is a dependency-free TypeScript client for the first-party `/api/v1`
contract. It supports GMB, public LinkedIn, and free AI-assisted discovery
without exposing provider credentials or requiring a browser session.

## Usage

```ts
import { LeadFinderClient } from 'lead-finder-integration-sdk';

const client = new LeadFinderClient({
  baseUrl: process.env.LEAD_FINDER_URL!,
  apiKey: process.env.LEAD_FINDER_INTEGRATION_KEY!,
});

const result = await client.searchUntilTerminal({
  companyType: 'HVAC contractor',
  sourceMode: 'ai',
  researchDepth: 'pro',
  location: { mode: 'cityState', city: 'Austin', stateCode: 'TX' },
  count: 100,
  phoneRequired: true,
});

for (const lead of result.leads) {
  console.log(lead.name, lead.mobile, lead.contactSourceUrl);
}
```

`searchUntilTerminal` polls only when the response advertises a durable,
pollable execution path. Stateless LinkedIn and AI fallbacks are returned
without an invalid polling loop. The SDK preserves machine-readable API errors,
request ids, limitations, provider coverage, evidence, and the mandatory
public-phone policy.

Use `client.getOpenApi()` to load the machine-readable contract from the same
deployment. The equivalent HTTP endpoint is
`GET /api/v1/capabilities?format=openapi`.

The key belongs in the calling server's secret manager. Do not ship an
integration key to a browser bundle. The API uses only public, legally
accessible sources; a public business number is not represented as a verified
personal mobile or direct line.

For durable searches, an optional `callback: { url: 'https://...' }` can be
included in the request. The deployment must configure a server-side callback
signing secret. Receivers should verify the HMAC signature and deduplicate the
at-least-once `eventId`; stateless fallback responses do not support callbacks.
