// Base class for platform-specific debug operations.
// Each platform (Nordic, STM32, etc.) implements its own handler
// that extends this class and provides the actual recover/flash/verify/reset logic.

export class PlatformHandler {
    constructor(targetConfig, logger) {
        if (new.target === PlatformHandler) {
            throw new Error('PlatformHandler is abstract and cannot be instantiated directly');
        }
        this.config = targetConfig;
        this.log = logger;
    }

    // Perform platform-specific device recovery (e.g., Nordic CTRL-AP mass erase).
    // @param {object} dap - DAPjs.ADI instance
    // @param {function} onProgress - Progress callback (0-100)
    // @returns {Promise<object>} The DAP instance (may be reconnected)
    async recover(dap, onProgress) {
        throw new Error('recover() must be implemented by platform handler');
    }

    // Flash firmware data to the device.
    // @param {object} dap - DAPjs.ADI instance
    // @param {Uint8Array} firmwareData - Binary firmware data
    // @param {number} startAddress - Flash start address
    // @param {function} onProgress - Progress callback (0-100)
    // @returns {Promise<void>}
    async flash(dap, firmwareData, startAddress, onProgress) {
        throw new Error('flash() must be implemented by platform handler');
    }

    // Verify written firmware against original data.
    // @param {object} dap - DAPjs.ADI instance
    // @param {Uint8Array} firmwareData - Expected firmware data
    // @param {number} startAddress - Flash start address
    // @param {function} onProgress - Progress callback (0-100)
    // @returns {Promise<{success: boolean, mismatches: number}>}
    async verify(dap, firmwareData, startAddress, onProgress) {
        throw new Error('verify() must be implemented by platform handler');
    }

    // Reset the target device.
    // @param {object} dap - DAPjs.ADI instance
    // @returns {Promise<void>}
    async reset(dap) {
        throw new Error('reset() must be implemented by platform handler');
    }

    // Create a fresh DAP instance. Useful after recover operations that
    // leave the DAP cache in an inconsistent state.
    // @param {object} transport - The underlying transport object
    // @returns {Promise<object>} New DAPjs.ADI instance, connected
    async createFreshDap(transport) {
        const dap = new DAPjs.ADI(transport);
        await dap.connect();
        return dap;
    }
}
