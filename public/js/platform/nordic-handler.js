// Nordic Semiconductor platform handler.
// Implements CTRL-AP recovery, RRAMC/NVMC flash programming, verification,
// and reset for Nordic nRF series microcontrollers.
//
// Portions of this file are derived from xiao-nrf54l15-web-flasher
// (BSD 3-Clause License, Copyright (c) 2026, Y.Yamashiro)

import { PlatformHandler } from './platform-handler.js';
import {
    readAPReg,
    writeAPReg,
    rawDapTransferWrite,
    getProxy,
    getTransport,
    sleep,
    DAP_PORT_DEBUG,
    DAP_PORT_ACCESS,
    DAP_TRANSFER_WRITE,
    DP_REG_SELECT,
    AP_CSW,
    AP_TAR,
    AP_DRW,
    CSW_VALUE
} from '../core/dap-operations.js';

// CTRL-AP register offsets (common across Nordic nRF series)
const CTRL_AP_RESET = 0x000;
const CTRL_AP_ERASEALL = 0x004;
const CTRL_AP_ERASEALLSTATUS = 0x008;
const CTRL_AP_ERASEPROTECTSTATUS = 0x00C;
const CTRL_AP_IDR_REG = 0x0FC;

export class NordicHandler extends PlatformHandler {
    constructor(targetConfig, logger) {
        super(targetConfig, logger);
        this.ctrlApNum = targetConfig.ctrlAp.num;
        this.ctrlApIdr = parseInt(targetConfig.ctrlAp.idr, 16);
        this.eraseAllStatus = targetConfig.eraseAllStatus;
        this.flashCtrl = targetConfig.flashController;
    }

    // =========================================================================
    // Recover: CTRL-AP mass erase
    // =========================================================================
    async recover(dap, onProgress) {
        this.log('Initializing DAP connection for recovery...', 'info');

        const idr = await readAPReg(dap, this.ctrlApNum, CTRL_AP_IDR_REG);

        if (idr === undefined) {
            this.log('Warning: Could not read CTRL-AP IDR', 'warning');
            this.log('Attempting mass erase anyway...', 'warning');
        } else {
            this.log(`CTRL-AP IDR: 0x${idr.toString(16).toUpperCase()}`, 'info');
            if (idr !== this.ctrlApIdr) {
                this.log(`Warning: Unexpected CTRL-AP IDR (expected 0x${this.ctrlApIdr.toString(16).toUpperCase()})`, 'warning');
            }
        }

        // Attempt mass erase
        let eraseSuccess = await this._attemptEraseAll(dap, onProgress, false);

        // Fallback: reconnect and retry
        if (!eraseSuccess) {
            this.log('Mass erase failed, attempting fallback (reconnect + retry)...', 'warning');
            try {
                await dap.disconnect();
                await sleep(500);
                await dap.connect();
                this.log('Reconnected for fallback erase', 'success');
                await sleep(200);
                eraseSuccess = await this._attemptEraseAll(dap, onProgress, true);
                if (!eraseSuccess) {
                    throw new Error('Both mass erase and fallback erase failed');
                }
            } catch (fallbackError) {
                throw new Error(`Erase failed: ${fallbackError.message}`);
            }
        }

        onProgress(80);

        // Reset device after erase
        await sleep(10);
        this.log('Resetting device...', 'info');
        await writeAPReg(dap, this.ctrlApNum, CTRL_AP_RESET, 2);
        await sleep(10);
        await writeAPReg(dap, this.ctrlApNum, CTRL_AP_RESET, 0);
        await writeAPReg(dap, this.ctrlApNum, CTRL_AP_ERASEALL, 0);

        this.log('Waiting for device to stabilize...', 'info');
        await sleep(500);

        onProgress(85);

        // Reconnect and verify
        this.log('Reconnecting to verify recovery...', 'info');
        try {
            await dap.reconnect();
            this.log('Reconnected successfully', 'success');
        } catch (reconnectError) {
            this.log(`Reconnect warning: ${reconnectError.message}`, 'warning');
        }

        await sleep(200);
        onProgress(90);

        // Verify accessibility
        await this._verifyRecovery(dap);

        onProgress(100);
        this.log('Mass erase completed successfully!', 'success');

        return dap;
    }

    // =========================================================================
    // Flash: write firmware to device
    // =========================================================================
    async flash(dap, firmwareData, startAddress, onProgress) {
        this.log(`Flashing ${firmwareData.length} bytes starting at 0x${startAddress.toString(16)}...`, 'info');

        const proxy = getProxy(dap);
        const transport = getTransport(proxy);

        if (!transport) {
            throw new Error('Could not find transport object in proxy');
        }

        // Pad to 32-bit word boundary
        const paddedSize = Math.ceil(firmwareData.length / 4) * 4;
        const paddedData = new Uint8Array(paddedSize);
        paddedData.fill(0xFF);
        paddedData.set(firmwareData);
        const words = new Uint32Array(paddedData.buffer);
        const totalWords = words.length;

        // Select MEM-AP (AP #0) bank 0
        await rawDapTransferWrite(transport, [{
            port: DAP_PORT_DEBUG,
            mode: DAP_TRANSFER_WRITE,
            register: DP_REG_SELECT,
            value: 0x00000000
        }]);

        // Write CSW for 32-bit access with auto-increment
        await rawDapTransferWrite(transport, [{
            port: DAP_PORT_ACCESS,
            mode: DAP_TRANSFER_WRITE,
            register: AP_CSW,
            value: CSW_VALUE
        }]);

        // Initialize flash controller based on type
        await this._initFlashController(dap, transport);

        // Write firmware word by word
        this.log(`Writing ${totalWords} words...`, 'info');
        let wordsWritten = 0;
        let currentTarAddress = -1;

        while (wordsWritten < totalWords) {
            const currentAddress = startAddress + (wordsWritten * 4);
            const needTarUpdate = (currentTarAddress === -1) ||
                                  ((currentAddress & 0x3FF) === 0);

            if (needTarUpdate) {
                await rawDapTransferWrite(transport, [{
                    port: DAP_PORT_ACCESS,
                    mode: DAP_TRANSFER_WRITE,
                    register: AP_TAR,
                    value: currentAddress
                }]);
                currentTarAddress = currentAddress;
            }

            await rawDapTransferWrite(transport, [{
                port: DAP_PORT_ACCESS,
                mode: DAP_TRANSFER_WRITE,
                register: AP_DRW,
                value: words[wordsWritten]
            }]);
            currentTarAddress += 4;
            wordsWritten++;

            // Progress update (throttled to every 256 words)
            if (wordsWritten % 256 === 0 || wordsWritten === totalWords) {
                const progress = (wordsWritten / totalWords) * 100;
                onProgress(progress);
                const bytesWritten = Math.min(wordsWritten * 4, firmwareData.length);
                this.log(`Flashed ${bytesWritten} / ${firmwareData.length} bytes`, 'info');
            }
        }

        this.log('Firmware write completed!', 'success');
    }

    // =========================================================================
    // Verify: read back and compare
    // =========================================================================
    async verify(dap, firmwareData, startAddress, onProgress) {
        this.log('Verifying firmware (reading back entire image)...', 'info');

        const verifySize = firmwareData.length;
        const verifyWords = Math.ceil(verifySize / 4);
        let mismatchCount = 0;

        for (let wordIdx = 0; wordIdx < verifyWords; wordIdx++) {
            const addr = startAddress + (wordIdx * 4);
            const actualWord = await dap.readMem32(addr);

            for (let byteOffset = 0; byteOffset < 4; byteOffset++) {
                const byteIdx = (wordIdx * 4) + byteOffset;
                if (byteIdx >= verifySize) break;

                const actualByte = (actualWord >> (8 * byteOffset)) & 0xFF;
                const expectedByte = firmwareData[byteIdx];

                if (actualByte !== expectedByte) {
                    mismatchCount++;
                    if (mismatchCount <= 5) {
                        this.log(
                            `Verify mismatch at 0x${(startAddress + byteIdx).toString(16)}: ` +
                            `expected 0x${expectedByte.toString(16).padStart(2, '0')}, ` +
                            `got 0x${actualByte.toString(16).padStart(2, '0')}`,
                            'warning'
                        );
                    }
                }
            }

            const progress = ((wordIdx + 1) / verifyWords) * 100;
            if (wordIdx % 256 === 0 || wordIdx === verifyWords - 1) {
                onProgress(progress);
            }

            if (wordIdx % 1024 === 0 && wordIdx > 0) {
                const bytesVerified = Math.min((wordIdx + 1) * 4, verifySize);
                this.log(`Verified ${bytesVerified} / ${verifySize} bytes`, 'info');
            }

            // Yield to UI every 256 words
            if (wordIdx % 256 === 0) {
                await new Promise(r => setTimeout(r, 0));
            }
        }

        if (mismatchCount > 0) {
            this.log(`Verification failed: ${mismatchCount} byte mismatches in ${verifySize} bytes`, 'error');
            return { success: false, mismatches: mismatchCount };
        }

        this.log(`Verification passed: all ${verifySize} bytes match`, 'success');
        return { success: true, mismatches: 0 };
    }

    // =========================================================================
    // Reset via CTRL-AP
    // =========================================================================
    async reset(dap) {
        this.log('Resetting device via CTRL-AP...', 'info');
        try {
            await writeAPReg(dap, this.ctrlApNum, CTRL_AP_RESET, 2);
            await sleep(10);
            await writeAPReg(dap, this.ctrlApNum, CTRL_AP_RESET, 0);
            await sleep(100);
            this.log('Device reset completed', 'success');
        } catch (error) {
            this.log(`CTRL-AP reset error: ${error.message}`, 'warning');
            this.log('Attempting fallback reset via DAP_RESET_TARGET...', 'info');
            try {
                await dap.reset();
                this.log('Fallback reset succeeded', 'success');
            } catch (fallbackError) {
                this.log(`Fallback reset also failed: ${fallbackError.message}`, 'error');
            }
        }
    }

    // =========================================================================
    // Internal: attempt ERASEALL
    // =========================================================================
    async _attemptEraseAll(dap, onProgress, isRetry) {
        const prefix = isRetry ? '[Retry] ' : '';
        const timeout = 300;

        this.log(`${prefix}Resetting ERASEALL task...`, 'info');
        await writeAPReg(dap, this.ctrlApNum, CTRL_AP_ERASEALL, 0);
        await sleep(10);

        this.log(`${prefix}Triggering mass erase (ERASEALL)...`, 'info');
        await writeAPReg(dap, this.ctrlApNum, CTRL_AP_ERASEALL, 1);

        // Wait for BUSY state
        this.log(`${prefix}Waiting for erase to start...`, 'info');
        let status;

        for (let i = 0; i < timeout; i++) {
            status = await readAPReg(dap, this.ctrlApNum, CTRL_AP_ERASEALLSTATUS);

            if (status === undefined) {
                await sleep(100);
                onProgress((i / timeout) * 30);
                continue;
            }

            if (status === this.eraseAllStatus.busy) {
                this.log(`${prefix}Erase in progress (BUSY)...`, 'info');
                break;
            }
            if (status === this.eraseAllStatus.error) {
                this.log(`${prefix}Erase failed with ERROR status`, 'error');
                return false;
            }
            if (status === this.eraseAllStatus.readyToReset) {
                this.log(`${prefix}Device already erased (READYTORESET)`, 'success');
                return true;
            }

            await sleep(100);
            onProgress((i / timeout) * 30);
        }

        if (status === undefined || (status !== this.eraseAllStatus.busy && status !== this.eraseAllStatus.readyToReset)) {
            this.log(`${prefix}Timeout waiting for erase to start`, 'error');
            return false;
        }

        // Wait for READYTORESET
        if (status === this.eraseAllStatus.busy) {
            this.log(`${prefix}Waiting for erase to complete...`, 'info');

            for (let i = 0; i < timeout; i++) {
                status = await readAPReg(dap, this.ctrlApNum, CTRL_AP_ERASEALLSTATUS);

                if (status === undefined) {
                    await sleep(100);
                    onProgress(30 + (i / timeout) * 50);
                    continue;
                }

                if (status === this.eraseAllStatus.readyToReset) {
                    this.log(`${prefix}Erase completed successfully (READYTORESET)`, 'success');
                    return true;
                }
                if (status === this.eraseAllStatus.error) {
                    this.log(`${prefix}Erase failed with ERROR status`, 'error');
                    return false;
                }

                await sleep(100);
                onProgress(30 + (i / timeout) * 50);
            }

            this.log(`${prefix}Timeout waiting for erase to complete`, 'error');
            return false;
        }

        return true;
    }

    // =========================================================================
    // Internal: verify recovery
    // =========================================================================
    async _verifyRecovery(dap) {
        this.log('Verifying device accessibility...', 'info');
        try {
            const verifyIdr = await readAPReg(dap, this.ctrlApNum, CTRL_AP_IDR_REG);
            if (verifyIdr !== undefined) {
                this.log(`Post-erase CTRL-AP IDR: 0x${verifyIdr.toString(16).toUpperCase()}`, 'success');
            }

            const protectStatus = await readAPReg(dap, this.ctrlApNum, CTRL_AP_ERASEPROTECTSTATUS);
            if (protectStatus !== undefined) {
                this.log(`ERASEPROTECTSTATUS: ${protectStatus}`, 'info');
                if (protectStatus >= 1) {
                    this.log('Device is unlocked', 'success');
                } else {
                    this.log('Warning: Device may still be locked', 'warning');
                    await sleep(500);
                    await dap.reconnect();
                    await sleep(200);
                    const retryStatus = await readAPReg(dap, this.ctrlApNum, CTRL_AP_ERASEPROTECTSTATUS);
                    if (retryStatus !== undefined && retryStatus >= 1) {
                        this.log('Device is now unlocked after retry', 'success');
                    } else {
                        this.log('Device still appears locked after retry', 'warning');
                    }
                }
            }
        } catch (verifyError) {
            this.log(`Verification warning: ${verifyError.message}`, 'warning');
            this.log('Device may need manual power cycle', 'warning');
        }
    }

    // =========================================================================
    // Internal: initialize flash controller (RRAMC or NVMC)
    // =========================================================================
    async _initFlashController(dap, transport) {
        const type = this.flashCtrl.type;
        const base = parseInt(this.flashCtrl.base, 16);

        if (type === 'rramc') {
            await this._initRRAMC(dap, transport, base);
        } else if (type === 'nvmc') {
            await this._initNVMC(dap, transport, base);
        } else {
            this.log(`Unknown flash controller type: ${type}`, 'warning');
        }
    }

    async _initRRAMC(dap, transport, base) {
        const configOffset = parseInt(this.flashCtrl.registers.config.offset, 16);
        const configValue = parseInt(this.flashCtrl.registers.config.enableValue, 16);
        const readyOffset = parseInt(this.flashCtrl.registers.ready.offset, 16);
        const configAddr = base + configOffset;
        const readyAddr = base + readyOffset;

        this.log('Configuring RRAMC for flash programming...', 'info');

        try {
            const currentConfig = await dap.readMem32(configAddr);
            this.log(`Current RRAMC CONFIG: 0x${currentConfig.toString(16)}`, 'info');

            await rawDapTransferWrite(transport, [{
                port: DAP_PORT_ACCESS,
                mode: DAP_TRANSFER_WRITE,
                register: AP_TAR,
                value: configAddr
            }]);
            await rawDapTransferWrite(transport, [{
                port: DAP_PORT_ACCESS,
                mode: DAP_TRANSFER_WRITE,
                register: AP_DRW,
                value: configValue
            }]);

            const newConfig = await dap.readMem32(configAddr);
            this.log(`New RRAMC CONFIG: 0x${newConfig.toString(16)}`, 'info');

            if ((newConfig & 0x1) !== 1) {
                this.log('Warning: RRAMC WEN bit not set', 'warning');
            } else {
                this.log('RRAMC write mode enabled', 'success');
            }

            // Wait for RRAMC ready
            let ready = await dap.readMem32(readyAddr);
            let retries = 0;
            while ((ready & 0x1) === 0 && retries < 100) {
                await sleep(10);
                ready = await dap.readMem32(readyAddr);
                retries++;
            }

            if ((ready & 0x1) === 0) {
                this.log('Warning: RRAMC not ready after timeout', 'warning');
            } else {
                this.log('RRAMC is ready for programming', 'success');
            }
        } catch (error) {
            this.log(`RRAMC configuration error: ${error.message}`, 'warning');
            this.log('Attempting flash write anyway...', 'info');
        }
    }

    async _initNVMC(dap, transport, base) {
        // NVMC initialization for nRF52 series
        // CONFIG register at offset 0x504: 1 = Write Enable, 2 = Erase Enable
        const NVMC_CONFIG = base + 0x504;
        const NVMC_READY = base + 0x400;
        const NVMC_CONFIG_WEN = 1;

        this.log('Configuring NVMC for flash programming...', 'info');

        try {
            await rawDapTransferWrite(transport, [{
                port: DAP_PORT_ACCESS,
                mode: DAP_TRANSFER_WRITE,
                register: AP_TAR,
                value: NVMC_CONFIG
            }]);
            await rawDapTransferWrite(transport, [{
                port: DAP_PORT_ACCESS,
                mode: DAP_TRANSFER_WRITE,
                register: AP_DRW,
                value: NVMC_CONFIG_WEN
            }]);

            // Wait for NVMC ready
            let ready = await dap.readMem32(NVMC_READY);
            let retries = 0;
            while ((ready & 0x1) === 0 && retries < 100) {
                await sleep(10);
                ready = await dap.readMem32(NVMC_READY);
                retries++;
            }

            if ((ready & 0x1) === 1) {
                this.log('NVMC write mode enabled', 'success');
            } else {
                this.log('Warning: NVMC not ready after timeout', 'warning');
            }
        } catch (error) {
            this.log(`NVMC configuration error: ${error.message}`, 'warning');
        }
    }
}
