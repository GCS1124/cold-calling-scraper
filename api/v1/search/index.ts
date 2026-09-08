import legacyHandler from '../../search/index.js';
import { requireIntegrationOwner } from '../../_lib/integration-handler.js';

export default requireIntegrationOwner(legacyHandler);
