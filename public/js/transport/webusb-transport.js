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
     * Prompt user to select a WebUSB device.
     *
     * The VID list in `usbFilters` (loaded from `public/targets/probe-filters.json`
     * via `loadProbeFilters()` in `core/probe-filters.js`) is used only to
     * narrow down the WebUSB chooser dialog for UX. The authoritative
     * CMSIS-DAP identification is performed after selection by checking that
     * the device's USB Product String contains "CMSIS-DAP", as required by
     * the CMSIS-DAP specification.
     *
     * The Product String match is case-insensitive to tolerate minor firmware
     * label variations seen in the wild (e.g. "Cmsis-DAP"); the "CMSIS-DAP"
     * substring itself is still required, so this only relaxes casing, not
     * content.
     *
     * When `options.skipProbeCheck` is true, both safeguards are lifted:
     * the VID whitelist is not applied (the chooser lists every connected
     * USB device), and the Product String match is skipped. This mode is
     * intended for advanced users whose CMSIS-DAP probe is not listed in
     * `probe-filters.json` and does not advertise a standard Product String.
     * The caller is responsible for surfacing an appropriate warning to the
     * user.
     *
     * @param {Array<{vendorId: number}>} usbFilters - Array of USB filter objects
     *   whose `vendorId` is a number (the probe-filters loader normalizes the
     *   JSON hex strings before they reach this function).
     * @param {object} [options] - Optional selection options
     * @param {boolean} [options.skipProbeCheck=false] - If true, bypass both
     *   the VID whitelist and the Product String check.
     * @returns {Promise<object>} DAPjs.WebUSB transport object
     * @throws {Error} If no device selected, selection fails, or the selected
     *                 device's Product String does not contain "CMSIS-DAP"
     *                 (the latter only when `skipProbeCheck` is false).
     */
    async selectDevice(usbFilters, options = {}) {
        const skipProbeCheck = !!options.skipProbeCheck;

        // With skipProbeCheck we pass an empty filters array so that
        // `navigator.usb.requestDevice` lists every attached USB device. Per
        // the Web USB spec an empty `filters` array is valid and means "no
        // filter".
        const filters = skipProbeCheck
            ? []
            : usbFilters.map(f => ({ vendorId: f.vendorId }));

        let device;
        try {
            device = await navigator.usb.requestDevice({ filters });
        } catch (error) {
            if (error.name === 'NotFoundError') {
                throw new Error('No device selected. Please select a CMSIS-DAP device.');
            }
            throw error;
        }

        if (!skipProbeCheck) {
            // Per the CMSIS-DAP specification, a compliant probe's USB Product
            // String must contain "CMSIS-DAP". The VID whitelist above only
            // narrows down the chooser dialog for UX; the authoritative
            // identification is this Product String check, which also lets us
            // support CMSIS-DAP probes from vendors not listed in the VID table.
            const productName = device.productName || '';
            if (!productName.toUpperCase().includes('CMSIS-DAP')) {
                throw new Error(
                    `Selected device is not a CMSIS-DAP probe: Product String ` +
                    `"${productName}" does not contain "CMSIS-DAP".`
                );
            }
        }

        this._device = device;
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
