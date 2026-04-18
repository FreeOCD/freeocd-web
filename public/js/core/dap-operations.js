// Low-level DAP operations
//
// This module provides raw DAP_TRANSFER operations that bypass DAP.js's
// buggy response parsing. DAP.js's transfer() and transferBlock() try to
// read data words from responses even for WRITE operations, causing
// "Offset is outside the bounds of the DataView" errors when the probe
// returns a shorter response (only cmd + count + ack for writes).
//
// These functions build raw DAP_TRANSFER packets and only parse the
// 3-byte header for write operations.
//
// Portions of this file are derived from xiao-nrf54l15-web-flasher
// (BSD 3-Clause License, Copyright (c) 2026, Y.Yamashiro)

// DP Register constants (from DAP.js dap/enums.ts)
export const DP_REG_SELECT = 0x8;  // AP Select register (write only)
export const DP_REG_RDBUFF = 0xC;  // Read Buffer register (read only)

// DAP Port and Transfer Mode constants (from DAP.js proxy/enums.ts)
export const DAP_PORT_DEBUG = 0x00;
export const DAP_PORT_ACCESS = 0x01;
export const DAP_TRANSFER_WRITE = 0x00;
export const DAP_TRANSFER_READ = 0x02;

// Bank Select Mask constants (from DAP.js dap/enums.ts)
const BANK_SELECT_APSEL = 0xFF000000;
const BANK_SELECT_APBANKSEL = 0x000000F0;

// CMSIS-DAP command constants
const DAP_COMMAND_TRANSFER = 0x05;

// MEM-AP register offsets (only A[3:2] bits used in transfer)
export const AP_CSW = 0x00;
export const AP_TAR = 0x04;
export const AP_DRW = 0x0C;

// CSW value for 32-bit access with auto-increment single
export const CSW_VALUE = 0x23000052;

/**
 * Create DP.SELECT value for a given AP number and register offset
 * @param {number} apNum - AP number (0-255)
 * @param {number} regOffset - Register offset
 * @returns {number} DP.SELECT value
 */
export function createSelectValue(apNum, regOffset) {
    const apsel = (apNum << 24) & BANK_SELECT_APSEL;
    const apbanksel = regOffset & BANK_SELECT_APBANKSEL;
    return apsel | apbanksel;
}

/**
 * Get the A[3:2] bits for the transfer request
 * @param {number} regOffset - Register offset
 * @returns {number} Transfer register value (A[3:2] bits)
 */
export function getTransferRegister(regOffset) {
    return regOffset & 0x0C;
}

/**
 * Get the underlying transport from a proxy or DAP instance
 * @param {object} dapOrProxy - DAPjs proxy or DAP instance
 * @returns {object|null} Transport object with write/read methods, or null
 */
export function getTransport(dapOrProxy) {
    const propNames = Object.getOwnPropertyNames(dapOrProxy);
    for (const name of propNames) {
        const prop = dapOrProxy[name];
        if (prop && typeof prop === 'object' && typeof prop.write === 'function' && typeof prop.read === 'function') {
            return prop;
        }
    }
    return null;
}

/**
 * Get the underlying CmsisDAP proxy from an ADI instance
 * @param {object} dap - DAPjs ADI instance
 * @returns {object} Proxy object with transferBlock method
 * @throws {Error} If proxy not found
 */
export function getProxy(dap) {
    const propNames = Object.getOwnPropertyNames(dap);
    for (const name of propNames) {
        const prop = dap[name];
        if (prop && typeof prop === 'object' && typeof prop.transferBlock === 'function') {
            return prop;
        }
    }
    throw new Error('Could not find proxy object with transferBlock in ADI instance');
}

/**
 * Raw DAP_TRANSFER write that bypasses DAP.js response parsing
 * Builds raw DAP_TRANSFER packets and only parses the 3-byte header
 * @param {object} transport - Transport object with write/read methods
 * @param {Array} operations - Array of transfer operation objects
 * @returns {Promise<boolean>} True if successful
 * @throws {Error} If transfer fails or response is invalid
 */
export async function rawDapTransferWrite(transport, operations) {
    const packetSize = 3 + (operations.length * 5);
    const packet = new Uint8Array(packetSize);
    const view = new DataView(packet.buffer);

    packet[0] = DAP_COMMAND_TRANSFER;
    packet[1] = 0;
    packet[2] = operations.length;

    let offset = 3;
    for (const op of operations) {
        packet[offset] = op.port | op.mode | op.register;
        view.setUint32(offset + 1, op.value || 0, true);
        offset += 5;
    }

    await transport.write(packet);
    const response = await transport.read();

    if (response.byteLength < 3) {
        throw new Error(`DAP_TRANSFER response too short: ${response.byteLength} bytes`);
    }

    const respCmd = response.getUint8(0);
    const respCount = response.getUint8(1);
    const respAck = response.getUint8(2);

    if (respCmd !== DAP_COMMAND_TRANSFER) {
        throw new Error(`Bad response command: expected 0x05, got 0x${respCmd.toString(16)}`);
    }

    if (respCount !== operations.length) {
        throw new Error(`Transfer count mismatch: expected ${operations.length}, got ${respCount}`);
    }

    const ackValue = respAck & 0x07;
    if (ackValue === 0x02) {
        throw new Error('Transfer response WAIT');
    }
    if (ackValue === 0x04) {
        throw new Error('Transfer response FAULT');
    }
    if (ackValue !== 0x01) {
        throw new Error(`Transfer response error: ACK=0x${respAck.toString(16)}`);
    }

    return true;
}

/**
 * Read AP register using array-based DAP transfers with retry logic
 * @param {object} dap - DAPjs ADI instance
 * @param {number} apNum - AP number
 * @param {number} regOffset - Register offset
 * @param {number} retries - Number of retry attempts (default: 3)
 * @returns {Promise<number|undefined>} Register value, or undefined if failed
 */
export async function readAPReg(dap, apNum, regOffset, retries = 3) {
    const selectValue = createSelectValue(apNum, regOffset);
    const transferReg = getTransferRegister(regOffset);

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            let proxy = null;
            const propNames = Object.getOwnPropertyNames(dap);
            for (const name of propNames) {
                const prop = dap[name];
                if (prop && typeof prop === 'object' && typeof prop.transfer === 'function') {
                    proxy = prop;
                    break;
                }
            }

            if (!proxy) {
                throw new Error('Could not find proxy object in ADI instance');
            }

            await proxy.transfer([{
                port: DAP_PORT_DEBUG,
                mode: DAP_TRANSFER_WRITE,
                register: DP_REG_SELECT,
                value: selectValue
            }]);

            await proxy.transfer([{
                port: DAP_PORT_ACCESS,
                mode: DAP_TRANSFER_READ,
                register: transferReg
            }]);

            const result = await proxy.transfer([{
                port: DAP_PORT_DEBUG,
                mode: DAP_TRANSFER_READ,
                register: DP_REG_RDBUFF
            }]);

            if (result && result.length > 0) {
                return result[0];
            }

            await sleep(50);
        } catch (error) {
            if (attempt < retries - 1) {
                await sleep(50);
            } else {
                throw error;
            }
        }
    }
    return undefined;
}

/**
 * Write AP register using array-based DAP transfers with retry logic
 * @param {object} dap - DAPjs ADI instance
 * @param {number} apNum - AP number
 * @param {number} regOffset - Register offset
 * @param {number} value - Value to write
 * @param {number} retries - Number of retry attempts (default: 3)
 * @returns {Promise<void>}
 * @throws {Error} If write fails after all retries
 */
export async function writeAPReg(dap, apNum, regOffset, value, retries = 3) {
    const selectValue = createSelectValue(apNum, regOffset);
    const transferReg = getTransferRegister(regOffset);

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            let proxy = null;
            const propNames = Object.getOwnPropertyNames(dap);
            for (const name of propNames) {
                const prop = dap[name];
                if (prop && typeof prop === 'object' && typeof prop.transfer === 'function') {
                    proxy = prop;
                    break;
                }
            }

            if (!proxy) {
                throw new Error('Could not find proxy object in ADI instance');
            }

            await proxy.transfer([{
                port: DAP_PORT_DEBUG,
                mode: DAP_TRANSFER_WRITE,
                register: DP_REG_SELECT,
                value: selectValue
            }]);

            await proxy.transfer([{
                port: DAP_PORT_ACCESS,
                mode: DAP_TRANSFER_WRITE,
                register: transferReg,
                value: value
            }]);

            return;
        } catch (error) {
            if (attempt < retries - 1) {
                await sleep(50);
            } else {
                throw error;
            }
        }
    }
}

/**
 * Sleep utility for async delays
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
export function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
