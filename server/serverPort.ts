/**
 * Shared delivery-server port constant.
 * Both server/index.ts and vite.config.ts import this file so a single
 * setting controls the listening port and the Vite /api proxy target.
 *
 * Override at runtime with the DELIVERY_PORT environment variable:
 *   DELIVERY_PORT=9000 bun run server
 *
 * The legacy PORT variable is also honoured (server only) for backwards
 * compatibility, but DELIVERY_PORT takes precedence.
 *
 * Default: 8791  (chosen to avoid the common 8787 conflict)
 */
export const DEFAULT_DELIVERY_PORT = 8791
