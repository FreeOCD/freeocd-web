// Transport interface for debug probe communication.
// All transport implementations must extend this class.
// This abstraction allows future support for WebSerial, etc.

export class TransportInterface {
    constructor() {
        if (new.target === TransportInterface) {
            throw new Error('TransportInterface is abstract and cannot be instantiated directly');
        }
    }

    // Prompt user to select a device and return the underlying transport object.
    // @param {Array} usbFilters - Array of USB filter objects (e.g., [{vendorId: 0x2886}])
    // @returns {Promise<object>} The transport object usable by DAPjs.ADI
    async selectDevice(usbFilters) {
        throw new Error('selectDevice() must be implemented');
    }

    // Get the underlying transport object for DAPjs.ADI construction.
    // @returns {object}
    getTransport() {
        throw new Error('getTransport() must be implemented');
    }

    // Get a human-readable name for the connected device.
    // @returns {string}
    getDeviceName() {
        throw new Error('getDeviceName() must be implemented');
    }

    // Get the transport type identifier.
    // @returns {string}
    static get type() {
        return 'unknown';
    }

    // Check if this transport is supported in the current browser.
    // @returns {boolean}
    static isSupported() {
        return false;
    }
}
