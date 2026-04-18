// Base class for platform-specific debug operations.
// Each platform (Nordic, STM32, etc.) implements its own handler
// that extends this class and provides the actual recover/flash/verify/reset logic.

/**
 * Base class for platform-specific debug operations
 * Each platform implements its own handler extending this class
 */
export class PlatformHandler {
    /**
     * Create a new PlatformHandler instance
     * @param {object} targetConfig - Target configuration from JSON
     * @param {function} logger - Logging function (message, type)
     * @throws {Error} If instantiated directly (abstract class)
     */
    constructor(targetConfig, logger) {
        if (new.target === PlatformHandler) {
            throw new Error('PlatformHandler is abstract and cannot be instantiated directly');
        }
        this.config = targetConfig;
        this.log = logger;
    }

    /**
     * Perform platform-specific device recovery (e.g., Nordic CTRL-AP mass erase)
     * @param {object} _dap - DAPjs.ADI instance
     * @param {function} _onProgress - Progress callback (0-100)
     * @returns {Promise<object>} The DAP instance (may be reconnected)
     * @throws {Error} Must be implemented by platform handler
     */
    async recover(_dap, _onProgress) {
        throw new Error('recover() must be implemented by platform handler');
    }

    /**
     * Flash firmware data to the device
     * @param {object} _dap - DAPjs.ADI instance
     * @param {Uint8Array} _firmwareData - Binary firmware data
     * @param {number} _startAddress - Flash start address
     * @param {function} _onProgress - Progress callback (0-100)
     * @returns {Promise<void>}
     * @throws {Error} Must be implemented by platform handler
     */
    async flash(_dap, _firmwareData, _startAddress, _onProgress) {
        throw new Error('flash() must be implemented by platform handler');
    }

    /**
     * Verify written firmware against original data
     * @param {object} _dap - DAPjs.ADI instance
     * @param {Uint8Array} _firmwareData - Expected firmware data
     * @param {number} _startAddress - Flash start address
     * @param {function} _onProgress - Progress callback (0-100)
     * @returns {Promise<{success: boolean, mismatches: number}>}
     * @throws {Error} Must be implemented by platform handler
     */
    async verify(_dap, _firmwareData, _startAddress, _onProgress) {
        throw new Error('verify() must be implemented by platform handler');
    }

    /**
     * Reset the target device
     * @param {object} _dap - DAPjs.ADI instance
     * @returns {Promise<void>}
     * @throws {Error} Must be implemented by platform handler
     */
    async reset(_dap) {
        throw new Error('reset() must be implemented by platform handler');
    }

    /**
     * Create a fresh DAP instance
     * Useful after recover operations that leave the DAP cache in an inconsistent state
     * @param {object} transport - The underlying transport object
     * @returns {Promise<object>} New DAPjs.ADI instance, connected
     */
    async createFreshDap(transport) {
        const dap = new DAPjs.ADI(transport);
        await dap.connect();
        return dap;
    }
}
