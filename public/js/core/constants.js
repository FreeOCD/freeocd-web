// Central timing and limit constants.
// All timeouts, settle delays, and UI limits live here so behaviour is
// auditable in one place and every long-running call stays bounded.

// DAP / USB operation bounds
export const DAP_CONNECT_TIMEOUT_MS = 10000;
export const DAP_DISCONNECT_TIMEOUT_MS = 5000;

// Settle delays after reset / reconnect
export const RTT_RESET_SETTLE_MS = 1000;
export const RESET_SETTLE_MS = 500;
export const DAP_RECONNECT_DELAY_MS = 200;

// UI
export const STEP_RESET_DELAY_MS = 3000;
export const MAX_LOG_LINES = 2000;

// State monitoring
export const STATE_POLLING_INTERVAL_MS = 1000;
