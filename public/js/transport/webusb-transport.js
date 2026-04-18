// WebUSB transport implementation.
// Wraps DAPjs.WebUSB to conform to the TransportInterface.

import { TransportInterface } from './transport-interface.js';

/**
 * WebUSB transport implementation
 * Wraps DAPjs.WebUSB to conform to the TransportInterface
 */
export class WebUSBTransport extends TransportInterface {
    constructor() {
        super();
        this._device = null;
        this._transport = null;
    }

    /**
     * Prompt user to select a WebUSB device
     * @param {Array} usbFilters - Array of USB filter objects
     * @returns {Promise<object>} DAPjs.WebUSB transport object
     * @throws {Error} If no device selected or selection fails
     */
    async selectDevice(usbFilters) {
        const filters = usbFilters.map(f => ({
            vendorId: typeof f.vendorId === 'string' ? parseInt(f.vendorId, 16) : f.vendorId
        }));

        try {
            this._device = await navigator.usb.requestDevice({ filters });
        } catch (error) {
            if (error.name === 'NotFoundError') {
                throw new Error('No device selected. Please select a CMSIS-DAP device.');
            }
            throw error;
        }

        this._transport = new DAPjs.WebUSB(this._device);
        return this._transport;
    }

    /**
     * Get the underlying DAPjs.WebUSB transport object
     * @returns {object} DAPjs.WebUSB transport object
     */
    getTransport() {
        return this._transport;
    }

    /**
     * Get a human-readable name for the connected device
     * @returns {string} Device name or 'No device'
     */
    getDeviceName() {
        if (!this._device) return 'No device';
        return this._device.productName || 'CMSIS-DAP Device';
    }

    /**
     * Get the transport type identifier
     * @returns {string} 'webusb'
     */
    static get type() {
        return 'webusb';
    }

    /**
     * Check if WebUSB is supported in the current browser
     * @returns {boolean} True if navigator.usb is available
     */
    static isSupported() {
        return !!navigator.usb;
    }
}
