import { ZodError } from 'zod';

const loadDeps = async () => {
  const [searchModule, serviceModule] = await Promise.all([
    import('../../server/src/types/search'),
    import('../../server/src/services/vercel-search-service'),
  ]);

  const searchRequestSchema =
    searchModule.searchRequestSchema ?? searchModule.default?.searchRequestSchema;
  const vercelSearchService =
    serviceModule.vercelSearchService ?? serviceModule.default?.vercelSearchService;

  if (!searchRequestSchema) {
    throw new Error('Search schema failed to load');
  }

  if (!vercelSearchService) {
    throw new Error('Search service failed to load');
  }

  return { searchRequestSchema, vercelSearchService };
};

export default async function handler(req: any, res: any) {
  if (req.method === 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const { searchRequestSchema, vercelSearchService } = await loadDeps();
    const payload = searchRequestSchema.parse(req.body);
    const response = await vercelSearchService.startSearch(payload);
    res.status(200).json(response);
  } catch (error) {
    if (error instanceof ZodError) {
      res.status(400).json({
        error: 'Invalid search request',
        details: error.flatten(),
      });
      return;
    }

    res.status(500).json({
      error: error instanceof Error ? error.message : 'Search failed',
    });
  }
}
