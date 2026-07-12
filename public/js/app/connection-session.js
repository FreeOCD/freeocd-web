// Connection session - owns the transport and every DAP-layer object created
// on top of it for one Flash/Recover/RTT session, so cleanup is a single
// dispose() call instead of scattered nullable globals.

import { WebUSBTransport } from '../transport/webusb-transport.js';
import { withTimeout } from '../core/async-utils.js';
import { DAP_DISCONNECT_TIMEOUT_MS } from '../core/constants.js';

export class ConnectionSession {
    constructor() {
        this._transport = null;
        this._disconnectables = [];
    }

    /**
     * Prompt for a device and open the WebUSB transport
     * @param {Array<{vendorId: number}>} usbFilters - Probe USB filters
     * @param {object} options - selectDevice options (e.g. skipProbeCheck)
     * @returns {Promise<void>}
     */
    async open(usbFilters, options) {
        this._transport = new WebUSBTransport();
        await this._transport.selectDevice(usbFilters, options);
    }

    /**
     * Get the underlying DAPjs transport object
     * @returns {object} DAPjs.WebUSB transport
     */
    getTransport() {
        return this._transport.getTransport();
    }

    /**
     * Get a human-readable device name
     * @returns {string}
     */
    getDeviceName() {
        return this._transport ? this._transport.getDeviceName() : 'No device';
    }

    /**
     * Check whether this session owns a given USBDevice (used to match
     * navigator.usb 'disconnect' events to the active session)
     * @param {USBDevice} usbDevice - Device from a WebUSB event
     * @returns {boolean}
     */
    ownsDevice(usbDevice) {
        return !!this._transport && this._transport.getDevice() === usbDevice;
    }

    /**
     * Register a DAP-layer object (DAPjs.ADI, DAPjs.CortexM, ...) whose
     * disconnect() must run when the session is disposed
     * @param {object} dapObject - Object with an async disconnect() method
     * @returns {object} The same object, for chaining
     */
    track(dapObject) {
        this._disconnectables.push(dapObject);
        return dapObject;
    }

    /**
     * Disconnect all tracked DAP objects (bounded by a timeout each) and drop
     * the transport. Safe to call multiple times; errors are swallowed because
     * dispose runs in cleanup paths where the device may already be gone.
     * @returns {Promise<void>}
     */
    async dispose() {
        for (const obj of this._disconnectables.reverse()) {
            try {
                await withTimeout(obj.disconnect(), DAP_DISCONNECT_TIMEOUT_MS, 'DAP disconnect');
            } catch (_) { /* ignore: device may already be gone */ }
        }
        this._disconnectables = [];
        this._transport = null;
    }
}
