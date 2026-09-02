'use strict';

process.env.NODE_ENV = 'production';

const { vercelSearchService } = require('../dist/server/src/services/vercel-search-service.js');

if (
  typeof vercelSearchService?.startSearch !== 'function' ||
  typeof vercelSearchService?.getSearch !== 'function'
) {
  throw new Error('Compiled Vercel search service did not expose the expected API.');
}

process.stdout.write('Compiled Vercel search runtime booted successfully.\n');
