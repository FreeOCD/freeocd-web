// Target manager: loads target definitions and instantiates platform handlers.

import { NordicHandler } from './nordic-handler.js';

// Registry of platform handlers. Add new platforms here.
const PLATFORM_HANDLERS = {
    nordic: NordicHandler
};

/**
 * Target manager for loading target definitions and instantiating platform handlers
 */
export class TargetManager {
    constructor() {
        this.targets = [];
        this.currentTarget = null;
        this.currentHandler = null;
        this.probeFilters = [];
        // Full target JSON cache populated by loadTargetIndex() so that
        // loadTarget(id) does not need to re-fetch the same file.
        this._targetDefCache = new Map();
    }

    /**
     * Set the CMSIS-DAP probe USB filter list. Typically loaded once at
     * application bootstrap from `public/targets/probe-filters.json` via
     * `loadProbeFilters()`.
     * @param {Array<{vendorId: number}>} filters - Probe filter objects
     */
    setProbeFilters(filters) {
        this.probeFilters = Array.isArray(filters) ? filters : [];
    }

    /**
     * Load the target index from the server.
     *
     * `index.json` is a flat list of target IDs (e.g.
     * `{"targets": ["nordic/nrf54/nrf54l15"]}`). Each referenced target JSON is
     * fetched in parallel to pull its display metadata (name, platform,
     * description, capabilities) and cached for reuse by loadTarget(). Targets
     * that fail to load are skipped (with a console warning) so a single bad
     * file does not break the whole selector; duplicate IDs are deduplicated.
     *
     * @param {string} basePath - Base path to the targets directory (e.g., 'targets')
     * @returns {Promise<{targets: Array, failedIds: Array<string>}>} The loaded
     *   target metadata list plus the IDs that failed to load. Callers can use
     *   `failedIds` to surface a user-visible warning when some targets were
     *   skipped.
     * @throws {Error} If the index itself cannot be loaded
     */
    async loadTargetIndex(basePath = 'targets') {
        const response = await fetch(`${basePath}/index.json`);
        if (!response.ok) {
            throw new Error(`Failed to load target index: ${response.status}`);
        }
        const index = await response.json();
        const rawIds = Array.isArray(index.targets) ? index.targets : [];

        // Deduplicate IDs while preserving order, and drop empty/non-string entries.
        const seen = new Set();
        const ids = [];
        for (const id of rawIds) {
            if (typeof id !== 'string' || id.length === 0) {
                console.warn('Skipping invalid entry in targets/index.json:', id);
                continue;
            }
            if (seen.has(id)) {
                console.warn(`Skipping duplicate target ID in targets/index.json: "${id}"`);
                continue;
            }
            seen.add(id);
            ids.push(id);
        }

        // Reset the full-def cache so stale entries from a previous load do not leak.
        this._targetDefCache.clear();

        const failedIds = [];
        const entries = await Promise.all(ids.map(async (id) => {
            try {
                const res = await fetch(`${basePath}/${id}.json`);
                if (!res.ok) {
                    console.warn(
                        `Failed to load target "${id}" (${basePath}/${id}.json): HTTP ${res.status}`
                    );
                    failedIds.push(id);
                    return null;
                }
                const def = await res.json();
                // Cache the full definition so loadTarget(id) is a no-op fetch.
                this._targetDefCache.set(id, def);
                return {
                    id,
                    name: typeof def.name === 'string' ? def.name : id,
                    platform: def.platform,
                    description: typeof def.description === 'string' ? def.description : '',
                    capabilities: Array.isArray(def.capabilities) ? def.capabilities : []
                };
            } catch (err) {
                console.warn(
                    `Failed to load target "${id}" (${basePath}/${id}.json):`,
                    err
                );
                failedIds.push(id);
                return null;
            }
        }));

        this.targets = entries.filter((e) => e !== null);
        return { targets: this.targets, failedIds };
    }

    /**
     * Load a specific target configuration by ID.
     *
     * If `loadTargetIndex()` already fetched this ID, the cached full JSON is
     * reused (no extra HTTP request); otherwise the file is fetched on demand.
     *
     * @param {string} targetId - Target ID (e.g., 'nordic/nrf54/nrf54l15')
     * @param {string} basePath - Base path to the targets directory
     * @returns {Promise<object>} The target configuration object
     * @throws {Error} If loading fails
     */
    async loadTarget(targetId, basePath = 'targets') {
        const cached = this._targetDefCache.get(targetId);
        if (cached) {
            this.currentTarget = cached;
            return this.currentTarget;
        }
        const response = await fetch(`${basePath}/${targetId}.json`);
        if (!response.ok) {
            throw new Error(`Failed to load target ${targetId}: ${response.status}`);
        }
        const def = await response.json();
        this._targetDefCache.set(targetId, def);
        this.currentTarget = def;
        return this.currentTarget;
    }

    /**
     * Clear the currently loaded target and its handler.
     *
     * Used by the UI when a target load fails so that `currentTarget` does not
     * leak stale data from the previously selected target. After this call,
     * `getCapabilities()` falls back to the default `['flash']` and
     * `createHandler()` throws until another target is successfully loaded.
     */
    clearCurrentTarget() {
        this.currentTarget = null;
        this.currentHandler = null;
    }

    /**
     * Create a platform handler for the currently loaded target
     * @param {function} logger - Logging function (message, type)
     * @returns {PlatformHandler} The platform handler instance
     * @throws {Error} If no target loaded or platform not found
     */
    createHandler(logger) {
        if (!this.currentTarget) {
            throw new Error('No target loaded. Call loadTarget() first.');
        }

        const platform = this.currentTarget.platform;
        const HandlerClass = PLATFORM_HANDLERS[platform];

        if (!HandlerClass) {
            throw new Error(`No handler registered for platform: ${platform}`);
        }

        this.currentHandler = new HandlerClass(this.currentTarget, logger);
        return this.currentHandler;
    }

    /**
     * Get USB filters for WebUSB device selection.
     *
     * The filter list is managed centrally in `public/targets/probe-filters.json`
     * (loaded at bootstrap via `setProbeFilters()`), because CMSIS-DAP probes
     * are orthogonal to the target MCU. Target JSONs must not carry their own
     * `usbFilters` field.
     *
     * A shallow copy of the internal array is returned so callers cannot mutate
     * the probe filter list via `push`/`sort`/etc. The filter objects
     * themselves are shared references, but they are treated as immutable by
     * all call sites.
     * @returns {Array<{vendorId: number}>} USB filter objects (fresh array)
     */
    getUsbFilters() {
        return [...this.probeFilters];
    }

    /**
     * Get capabilities of the current target
     * @returns {Array<string>} Capability strings (e.g., ['recover', 'flash'])
     */
    getCapabilities() {
        if (!this.currentTarget || !this.currentTarget.capabilities) {
            return ['flash'];
        }
        return this.currentTarget.capabilities;
    }

    /**
     * Check if the current target supports a specific capability
     * @param {string} capability - Capability name
     * @returns {boolean} True if capability is supported
     */
    hasCapability(capability) {
        return this.getCapabilities().includes(capability);
    }
}
