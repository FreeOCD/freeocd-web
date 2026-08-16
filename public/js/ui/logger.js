// Operation log UI.
// Timestamped, colour-coded log lines with auto-scroll and a bounded line
// count so long RTT sessions do not grow the DOM without limit.

import { MAX_LOG_LINES } from '../core/constants.js';

let logEl = null;
let containerEl = null;
let shouldAutoScroll = () => true;

/**
 * Initialize the logger with its DOM elements
 * @param {object} config - Logger configuration
 * @param {HTMLElement} config.element - Element that receives log lines
 * @param {HTMLElement} config.container - Scrollable container element
 * @param {function} [config.autoScroll] - Returns true when auto-scroll is enabled
 */
export function initLogger({ element, container, autoScroll }) {
    logEl = element;
    containerEl = container;
    if (autoScroll) {
        shouldAutoScroll = autoScroll;
    }
}

/**
 * Append a timestamped message to the operation log
 * @param {string} message - Message text
 * @param {string} type - Log type: 'info', 'success', 'warning', 'error'
 */
export function log(message, type = 'info') {
    if (!logEl) return;
    const timestamp = new Date().toLocaleTimeString();
    const span = document.createElement('span');
    span.className = `log-${type}`;
    span.textContent = `[${timestamp}] ${message}\n`;
    logEl.appendChild(span);

    while (logEl.children.length > MAX_LOG_LINES) {
        logEl.removeChild(logEl.firstChild);
    }

    if (containerEl && shouldAutoScroll()) {
        containerEl.scrollTop = containerEl.scrollHeight;
    }
}

/** Clear all log lines */
export function clearLog() {
    if (logEl) {
        logEl.innerHTML = '';
    }
}
