/**
 * Copilot route entrypoint.
 * @module routes/copilot
 */

import {createCopilotRouteRuntime} from '../services/copilot/index.js';
import logger from '../utils/logger.js';

const copilotRuntime = createCopilotRouteRuntime({logger});

export const supportsResponsesWebSocket = copilotRuntime.supportsResponsesWebSocket;
export const {handleCopilotResponsesWS} = copilotRuntime;

export async function routeCopilotRequest(req, res) {
    return copilotRuntime.routeCopilotRequest(req, res);
}
