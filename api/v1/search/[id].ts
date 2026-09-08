import legacyHandler from '../../search/[id].js';
import { requireIntegrationOwner } from '../../_lib/integration-handler.js';

export default requireIntegrationOwner(legacyHandler);
