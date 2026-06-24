/**
 * CodeBuddy route entrypoint.
 * @module routes/codebuddy
 */

import {unifiedTenantManager} from '../services/gateway/index.js';
import {createCodebuddyRouteRuntime} from '../services/codebuddy/index.js';
import logger from '../utils/logger.js';

const codebuddyRuntime = createCodebuddyRouteRuntime({
    tenantManager: unifiedTenantManager,
    logger
});

export const {handleCodebuddyResponsesWS} = codebuddyRuntime;

export async function routeCodebuddyRequest(req, res) {
    return codebuddyRuntime.routeCodebuddyRequest(req, res);
}
