// RTT controller.
// Owns the RTT connection lifecycle (connect, poll, disconnect, cleanup), the
// terminal, and the RTT-backed utility operations (reset, halt/resume, memory
// and SWJ access).

import { RTTHandler } from '../core/rtt-handler.js';
import { Terminal } from '../core/terminal.js';
import { sleep, withTimeout } from '../core/async-utils.js';
import {
    DAP_CONNECT_TIMEOUT_MS,
    RTT_RESET_SETTLE_MS,
    RESET_SETTLE_MS
} from '../core/constants.js';
import { log } from '../ui/logger.js';
import { operationLock } from './operation-lock.js';
import { ConnectionSession } from './connection-session.js';

/**
 * Create the RTT controller
 * @param {object} ctx - Dependencies injected by main.js:
 *   - dom {object} - DOM references (rtt inputs, terminal container)
 *   - targetManager {TargetManager}
 *   - stateManager {StateManager}
 *   - getSelectDeviceOptions {function} - Options for transport.selectDevice()
 *   - updateStatus {function} - Status bar updater
 *   - setButtonsEnabled {function} - Flash/Recover button gating
 *   - updateUtilityButtons {function} - Utility button gating
 * @returns {object} Controller API
 */
export function createRttController(ctx) {
    const { dom, targetManager, stateManager } = ctx;

    let session = null;
    let rttProcessor = null;
    let rttHandler = null;
    let terminal = null;
    let rttPollingInterval = 10; // ms (RTT data polling, separate from StateManager polling)
    let rttDataAbortController = null;

    // -------------------------------------------------------------------------
    // Terminal
    // -------------------------------------------------------------------------

    function initTerminal() {
        if (terminal) return;
        terminal = new Terminal(dom.rttTerminalContainer, {
            onSend: (data) => sendToRtt(data),
            onClear: () => log('Terminal cleared', 'info'),
            onSave: (text) => saveRttLog(text)
        });
        terminal.init();
        terminal.disable(); // Disable until connected
    }

    function saveRttLog(text) {
        const blob = new Blob([text], { type: 'text/plain' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `rtt-log-${Date.now()}.txt`;
        a.click();
        URL.revokeObjectURL(url);
        log('RTT log saved', 'success');
    }

    async function sendToRtt(data) {
        if (!rttHandler || !stateManager.getState().isRttConnected) {
            return;
        }
        try {
            const bytes = new TextEncoder().encode(data);
            const result = await rttHandler.write(0, bytes);
            if (result < 0) {
                log('RTT buffer full, data not sent', 'warning');
            }
        } catch (error) {
            log(`RTT send error: ${error.message}`, 'error');
        }
    }

    // -------------------------------------------------------------------------
    // Connection lifecycle
    // -------------------------------------------------------------------------

    async function connectRtt() {
        if (!operationLock.tryAcquire('RTT', 'connectRtt')) {
            log(`Cannot connect RTT: ${operationLock.getCurrentLock()} operation is in progress`, 'warning');
            return;
        }

        if (stateManager.getState().isRttConnected) {
            operationLock.release('RTT');
            return;
        }

        try {
            log('=== RTT Connection ===', 'info');
            ctx.updateStatus('Selecting device for RTT...', false, true, 'Connecting RTT');

            session = new ConnectionSession();
            await session.open(targetManager.getUsbFilters(), ctx.getSelectDeviceOptions());

            const deviceName = session.getDeviceName();
            log(`Device selected: ${deviceName}`, 'success');

            // Create CortexM processor for RTT
            rttProcessor = session.track(new DAPjs.CortexM(session.getTransport()));
            await withTimeout(rttProcessor.connect(), DAP_CONNECT_TIMEOUT_MS, 'DAP connect');
            log('DAP connected for RTT', 'success');

            // Halt and reset to ensure clean state
            await rttProcessor.softReset();
            await sleep(RTT_RESET_SETTLE_MS);
            await rttProcessor.halt();

            // Get RTT settings
            const scanStart = parseInt(dom.rttScanStart.value, 16) || 0x20000000;
            const scanRange = parseInt(dom.rttScanRange.value, 16) || 0x10000;
            rttPollingInterval = parseInt(dom.rttPollingInterval.value) || 1;

            log(`Scanning for RTT at 0x${scanStart.toString(16)} (range: 0x${scanRange.toString(16)})`, 'info');

            rttHandler = new RTTHandler(rttProcessor, {
                scanStartAddress: scanStart,
                scanRange: scanRange
            });

            const numBufs = await rttHandler.init();
            if (numBufs < 0) {
                throw new Error('RTT control block not found');
            }

            log(`RTT initialized: ${numBufs} buffers found`, 'success');

            await rttProcessor.resume();

            stateManager.setRttComponents(rttProcessor, rttHandler);

            if (terminal) {
                terminal.enable();
                terminal.focus();
            }

            // StateManager polling monitors connection health at a fixed 1s
            // interval; RTT data polling below uses the user-configurable one.
            stateManager.startPolling();
            startRttDataPolling();

            stateManager.setRttConnected(true);
            stateManager.setDeviceConnected(true);

            ctx.updateStatus(`RTT Connected: ${deviceName}`, true, false);

            ctx.setButtonsEnabled(false);
            ctx.updateUtilityButtons();

            log('=== RTT Connected Successfully ===', 'success');

        } catch (error) {
            log(`RTT connection error: ${error.message}`, 'error');
            ctx.updateStatus('RTT connection failed', false, false);
            await cleanupRtt();
            operationLock.release('RTT');
        }
    }

    async function disconnectRtt() {
        if (!stateManager.getState().isRttConnected) {
            return;
        }

        log('Disconnecting RTT...', 'info');

        stateManager.stopPolling();
        stopRttDataPolling();

        await cleanupRtt();

        stateManager.setRttConnected(false);
        stateManager.setDeviceConnected(false);

        operationLock.release('RTT');

        ctx.updateStatus('RTT Disconnected', false, false);
        ctx.setButtonsEnabled(true);

        log('RTT disconnected', 'success');
    }

    async function cleanupRtt() {
        stopRttDataPolling();
        stateManager.stopPolling();

        rttProcessor = null;
        rttHandler = null;

        if (session) {
            await session.dispose();
            session = null;
        }

        stateManager.setRttComponents(null, null);

        if (terminal) {
            terminal.disable();
        }
    }

    /**
     * Handle a physical USB disconnect event. If the unplugged device belongs
     * to the active RTT session, tear the session down immediately instead of
     * waiting for the state polling to notice.
     * @param {USBDevice} usbDevice - Device from the 'disconnect' event
     */
    async function handleUsbDisconnect(usbDevice) {
        if (!session || !session.ownsDevice(usbDevice)) {
            return;
        }
        log('USB device disconnected', 'warning');
        if (stateManager.getState().isRttConnected) {
            await disconnectRtt();
        } else {
            await cleanupRtt();
        }
    }

    // -------------------------------------------------------------------------
    // Data polling
    // -------------------------------------------------------------------------

    function startRttDataPolling() {
        if (rttDataAbortController) {
            return;
        }

        rttDataAbortController = new AbortController();

        async function pollLoop() {
            while (!rttDataAbortController.signal.aborted) {
                try {
                    if (rttHandler && stateManager.getState().isRttConnected) {
                        const data = await rttHandler.read(0);
                        if (data.length > 0) {
                            const text = new TextDecoder().decode(data);
                            if (terminal) {
                                terminal.write(text, 'output');
                            }
                        }

                        const bufInfo = rttHandler.getBufferInfo(0, true);
                        if (terminal && bufInfo) {
                            terminal.updateBufferInfo(bufInfo);
                        }
                    }
                } catch (error) {
                    if (!rttDataAbortController.signal.aborted) {
                        log(`RTT data polling error: ${error.message}`, 'warning');
                    }
                }

                await sleep(rttPollingInterval);
            }
        }

        pollLoop();
    }

    function stopRttDataPolling() {
        if (rttDataAbortController) {
            rttDataAbortController.abort();
            rttDataAbortController = null;
        }
    }

    // -------------------------------------------------------------------------
    // Utility operations (all require an active RTT connection)
    // -------------------------------------------------------------------------

    /**
     * Wrap an RTT-backed utility operation with the shared connection guard
     * and error handling
     * @param {string} name - Operation name used in error logs
     * @param {function} fn - Async function receiving the RTT processor
     * @returns {function} Event-handler-compatible async function
     */
    function withRttConnection(name, fn) {
        return async () => {
            if (!stateManager.getState().isRttConnected || !rttProcessor) {
                log('No RTT connection', 'error');
                return;
            }
            try {
                await fn(rttProcessor);
            } catch (error) {
                log(`${name} failed: ${error.message}`, 'error');
            }
        };
    }

    const performSoftReset = withRttConnection('Soft reset', async (processor) => {
        log('Performing soft reset...', 'info');
        await processor.softReset();
        await sleep(RESET_SETTLE_MS);
        log('Soft reset completed', 'success');
    });

    const performHardReset = withRttConnection('Hard reset', async (processor) => {
        log('Performing hard reset...', 'info');
        await processor.reset();
        await sleep(RESET_SETTLE_MS);
        log('Hard reset completed', 'success');
    });

    const readDeviceInfo = withRttConnection('Read device info', async (processor) => {
        log('Reading device information...', 'info');

        const infoTypes = [
            { name: 'Vendor ID', request: 0x01 },
            { name: 'Product ID', request: 0x02 },
            { name: 'Serial Number', request: 0x03 },
            { name: 'Firmware Version', request: 0x04 },
            { name: 'Target Device Vendor', request: 0x05 },
            { name: 'Target Device Name', request: 0x06 },
            { name: 'Capabilities', request: 0xF0 },
            { name: 'Packet Count', request: 0xFE },
            { name: 'Packet Size', request: 0xFF }
        ];

        for (const info of infoTypes) {
            try {
                const result = await processor.dapInfo(info.request);
                log(`${info.name}: ${result}`, 'info');
            } catch (_) {
                log(`${info.name}: Not available`, 'warning');
            }
        }

        log('Device information read completed', 'success');
    });

    const performHalt = withRttConnection('Halt', async (processor) => {
        log('Halting CPU...', 'info');
        await processor.halt();
        log('CPU halted', 'success');
    });

    const performResume = withRttConnection('Resume', async (processor) => {
        log('Resuming CPU...', 'info');
        await processor.resume();
        log('CPU resumed', 'success');
    });

    const getCoreState = withRttConnection('Get core state', async (processor) => {
        log('Reading core state...', 'info');
        const coreState = await processor.getState();
        const stateNames = ['RESET', 'LOCKUP', 'SLEEPING', 'DEBUG', 'RUNNING'];
        log(`Core state: ${stateNames[coreState]}`, 'success');
    });

    const readMemory = withRttConnection('Read memory', async (processor) => {
        const address = parseInt(dom.memReadAddress.value, 16);
        const length = parseInt(dom.memReadLength.value);

        if (isNaN(address)) {
            log('Invalid address', 'error');
            return;
        }

        if (isNaN(length) || length <= 0 || length > 4096) {
            log('Invalid length (must be 1-4096)', 'error');
            return;
        }

        log(`Reading memory at 0x${address.toString(16)} (${length} bytes)...`, 'info');
        const data = await processor.readBytes(address, length);

        const hexString = Array.from(data)
            .map(b => b.toString(16).padStart(2, '0').toUpperCase())
            .join(' ');
        log(`Memory data: ${hexString}`, 'success');
    });

    const writeMemory = withRttConnection('Write memory', async (processor) => {
        const address = parseInt(dom.memWriteAddress.value, 16);
        const dataStr = dom.memWriteData.value.trim();

        if (isNaN(address)) {
            log('Invalid address', 'error');
            return;
        }

        if (!dataStr) {
            log('No data specified', 'error');
            return;
        }

        // Parse hex data (space-separated)
        const hexBytes = dataStr.split(/\s+/).map(s => parseInt(s, 16));
        if (hexBytes.some(isNaN)) {
            log('Invalid hex data', 'error');
            return;
        }

        log(`Writing ${hexBytes.length} bytes to 0x${address.toString(16)}...`, 'info');

        for (let i = 0; i < hexBytes.length; i++) {
            await processor.writeMem8(address + i, hexBytes[i]);
        }

        log('Memory write completed', 'success');
    });

    const controlSwjPins = withRttConnection('Control SWJ pins', async (processor) => {
        const pinOutput = parseInt(dom.swjPinOutput.value, 16);
        const pinSelect = parseInt(dom.swjPinSelect.value, 16);
        const pinWait = parseInt(dom.swjPinWait.value);

        if (isNaN(pinOutput) || isNaN(pinSelect) || isNaN(pinWait)) {
            log('Invalid pin values', 'error');
            return;
        }

        log(`Controlling SWJ pins (output: 0x${pinOutput.toString(16)}, select: 0x${pinSelect.toString(16)}, wait: ${pinWait}μs)...`, 'info');

        const result = await processor.swjPins(pinOutput, pinSelect, pinWait);
        log(`Pin state after control: 0x${result.toString(16)}`, 'success');
    });

    const setSwjClock = withRttConnection('Set SWJ clock', async (processor) => {
        const clock = parseInt(dom.swjClock.value);

        if (isNaN(clock) || clock <= 0) {
            log('Invalid clock frequency', 'error');
            return;
        }

        log(`Setting SWJ clock to ${clock} Hz...`, 'info');
        await processor.swjClock(clock);
        log('SWJ clock set completed', 'success');
    });

    return {
        initTerminal,
        connectRtt,
        disconnectRtt,
        cleanupRtt,
        handleUsbDisconnect,
        hasProcessor: () => rttProcessor !== null,
        performSoftReset,
        performHardReset,
        readDeviceInfo,
        performHalt,
        performResume,
        getCoreState,
        readMemory,
        writeMemory,
        controlSwjPins,
        setSwjClock
    };
}
