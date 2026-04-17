// Target manager: loads target definitions and instantiates platform handlers.

import { NordicHandler } from './nordic-handler.js';

// Registry of platform handlers. Add new platforms here.
const PLATFORM_HANDLERS = {
    nordic: NordicHandler
};

export class TargetManager {
    constructor() {
        this.targets = [];
        this.currentTarget = null;
        this.currentHandler = null;
    }

    // Load the target index from the server.
    // @param {string} basePath - Base path to the targets directory (e.g., 'targets')
    async loadTargetIndex(basePath = 'targets') {
        const response = await fetch(`${basePath}/index.json`);
        if (!response.ok) {
            throw new Error(`Failed to load target index: ${response.status}`);
        }
        const index = await response.json();
        this.targets = index.targets;
        return this.targets;
    }

    // Load a specific target configuration by ID.
    // @param {string} targetId - Target ID (e.g., 'nordic/nrf54/nrf54l15')
    // @param {string} basePath - Base path to the targets directory
    // @returns {Promise<object>} The target configuration object
    async loadTarget(targetId, basePath = 'targets') {
        const response = await fetch(`${basePath}/${targetId}.json`);
        if (!response.ok) {
            throw new Error(`Failed to load target ${targetId}: ${response.status}`);
        }
        this.currentTarget = await response.json();
        return this.currentTarget;
    }

    // Create a platform handler for the currently loaded target.
    // @param {function} logger - Logging function (message, type)
    // @returns {PlatformHandler} The platform handler instance
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

    // Get USB filters for the current target (for WebUSB device selection).
    // @returns {Array} USB filter objects
    getUsbFilters() {
        if (!this.currentTarget || !this.currentTarget.usbFilters) {
            return [];
        }
        return this.currentTarget.usbFilters;
    }

    // Get capabilities of the current target.
    // @returns {Array<string>} Capability strings (e.g., ['recover', 'flash'])
    getCapabilities() {
        if (!this.currentTarget || !this.currentTarget.capabilities) {
            return ['flash'];
        }
        return this.currentTarget.capabilities;
    }

    // Check if the current target supports a specific capability.
    // @param {string} capability - Capability name
    // @returns {boolean}
    hasCapability(capability) {
        return this.getCapabilities().includes(capability);
    }
}
