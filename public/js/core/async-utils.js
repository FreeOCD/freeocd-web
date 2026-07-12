// Async utilities shared across the application.

/**
 * Sleep utility for async delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Bound a promise with a timeout so a hung USB/DAP call cannot freeze the UI.
 * @param {Promise} promise - Promise to bound
 * @param {number} ms - Timeout in milliseconds
 * @param {string} label - Human-readable operation name for the error message
 * @returns {Promise} Resolves/rejects with the original promise, or rejects
 *   with a timeout error after `ms` milliseconds
 */
export function withTimeout(promise, ms, label) {
    let timerId;
    const timeout = new Promise((_, reject) => {
        timerId = setTimeout(
            () => reject(new Error(`${label} timed out after ${ms} ms`)),
            ms
        );
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timerId));
}
