import { getSearchJobSnapshot } from '../../../server/src/services/search-job-snapshot.js';
import { buildResearchDossier } from '../../../server/src/services/research-dossier.js';

export default async function handler(req: any, res: any) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const searchId = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const requestedLeadId = Array.isArray(req.query.leadId)
    ? req.query.leadId[0]
    : req.query.leadId;

  if (!searchId) {
    res.status(400).json({ error: 'Missing search id' });
    return;
  }

  try {
    const response = await getSearchJobSnapshot(searchId);
    if (!response) {
      res.status(404).json({ error: 'Search not found or already expired' });
      return;
    }

    const dossier = buildResearchDossier(response, requestedLeadId);
    if (requestedLeadId && dossier.leads.length === 0) {
      res.status(404).json({ error: 'Lead not found in this search' });
      return;
    }

    res.setHeader?.('Cache-Control', 'no-store, max-age=0');
    res.status(200).json(dossier);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Unable to load research evidence',
    });
  }
}
