// WebUSB transport implementation.
// Wraps DAPjs.WebUSB to conform to the TransportInterface.

import { TransportInterface } from './transport-interface.js';

export class WebUSBTransport extends TransportInterface {
    constructor() {
        super();
        this._device = null;
        this._transport = null;
    }

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

    getTransport() {
        return this._transport;
    }

    getDeviceName() {
        if (!this._device) return 'No device';
        return this._device.productName || 'CMSIS-DAP Device';
    }

    static get type() {
        return 'webusb';
    }

    static isSupported() {
        return !!navigator.usb;
    }
}
