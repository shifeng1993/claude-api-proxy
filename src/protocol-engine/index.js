/**
 * Public protocol engine boundary.
 *
 * App, provider, session, and product service layers should import protocol
 * capabilities from here instead of depending on the core implementation layout.
 * This keeps the engine ready to move into a separate package later.
 * @module protocol-engine
 */

export * from './core/index.js';
