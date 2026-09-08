import legacyHandler from '../../../search/[id]/reverify.js';
import { requireIntegrationOwner } from '../../../_lib/integration-handler.js';

export default requireIntegrationOwner(legacyHandler);
