// Flash / Recover controller.
// Both operations share the same orchestration (lock, RTT teardown, connect,
// mass erase, reset, cleanup); runOperation() implements it once and the
// flash-specific middle steps are injected as a callback.

import { sleep, withTimeout } from '../core/async-utils.js';
import { DAP_CONNECT_TIMEOUT_MS, DAP_RECONNECT_DELAY_MS } from '../core/constants.js';
import { log, clearLog } from '../ui/logger.js';
import {
    initStepProgress,
    activateStep,
    updateStepProgress,
    completeStep,
    failStep,
    resetStepProgress,
    scheduleStepReset,
    cancelScheduledStepReset,
    isStepProgressVisible
} from '../ui/step-progress.js';
import { operationLock } from './operation-lock.js';
import { ConnectionSession } from './connection-session.js';

// Step definitions for each operation mode
export const FLASH_STEPS_VERIFY = ['🔌 Connect', '🗑️ Mass Erase', '📤 Flash', '✅ Verify', '🔄 Reset'];
export const FLASH_STEPS_NO_VERIFY = ['🔌 Connect', '🗑️ Mass Erase', '📤 Flash', '🔄 Reset'];
export const RECOVER_STEPS = ['🔌 Connect', '🗑️ Mass Erase', '🔄 Reset'];

/**
 * Create the flash/recover controller
 * @param {object} ctx - Dependencies injected by main.js:
 *   - dom {object} - DOM references (verifyCheckbox)
 *   - targetManager {TargetManager}
 *   - stateManager {StateManager}
 *   - rttController {object} - For disconnecting RTT before an operation
 *   - getSelectDeviceOptions {function}
 *   - getParsedFirmware {function}
 *   - updateStatus {function}
 *   - setButtonsEnabled {function}
 * @returns {object} Controller API: { runFlash, runRecover }
 */
export function createFlashController(ctx) {
    const { targetManager, stateManager, rttController } = ctx;

    /**
     * Shared runner for Flash and Recover.
     *
     * Sequence: acquire lock -> disconnect RTT -> connect -> mass erase ->
     * [middle steps] -> reset -> disconnect -> cleanup.
     * @param {object} config - Operation configuration
     * @param {string} config.type - 'FLASH' or 'RECOVER' (lock type)
     * @param {string} config.title - Log banner title
     * @param {Array<string>} config.steps - Step names for the progress UI
     * @param {function} [config.middle] - Optional async callback executed
     *   between mass erase and reset. Receives ({ handler, dap, session,
     *   stepper }) and must return the DAP instance to use for the remaining
     *   steps (it may create a fresh one).
     */
    async function runOperation({ type, title, steps, middle }) {
        if (!operationLock.tryAcquire(type, `run${title}`)) {
            log(`Cannot start ${title}: ${operationLock.getCurrentLock()} operation is in progress`, 'warning');
            return;
        }

        // If step progress is already visible, clear it immediately
        if (isStepProgressVisible()) {
            log('Clearing previous operation progress...', 'info');
            cancelScheduledStepReset();
            resetStepProgress();
        }

        // Disconnect RTT if connected
        const wasRttConnected = stateManager.getState().isRttConnected;
        if (wasRttConnected) {
            log(`RTT is connected, disconnecting for ${title.toLowerCase()} operation...`, 'info');
            await rttController.disconnectRtt();
            if (!operationLock.tryAcquire(type, `run${title}`)) {
                log(`Cannot start ${title}: ${operationLock.getCurrentLock()} operation is in progress`, 'warning');
                return;
            }
        }

        // Stop StateManager polling during the operation
        stateManager.stopPolling();

        clearLog();
        ctx.setButtonsEnabled(false);

        initStepProgress(steps);

        const session = new ConnectionSession();
        let dap;
        let stepIdx = 0;

        // Small helper so step bookkeeping cannot drift between operations
        const stepper = {
            get index() { return stepIdx; },
            begin() { activateStep(stepIdx); },
            done() { completeStep(stepIdx); stepIdx++; },
            progress(p, text) { updateStepProgress(stepIdx, p, text); }
        };

        try {
            // Step: Connect
            stepper.begin();
            log(`=== ${title} Operation ===`, 'info');

            ctx.updateStatus('Selecting device...', false, true, 'Connecting');
            await session.open(targetManager.getUsbFilters(), ctx.getSelectDeviceOptions());

            const deviceName = session.getDeviceName();
            log(`Device selected: ${deviceName}`, 'success');
            ctx.updateStatus(`Connected: ${deviceName}`, true, true, 'Mass Erasing');

            const handler = targetManager.createHandler(log);
            dap = session.track(new DAPjs.ADI(session.getTransport()));
            await withTimeout(dap.connect(), DAP_CONNECT_TIMEOUT_MS, 'DAP connect');
            log('DAP connected', 'success');
            stepper.done();

            // Step: Mass Erase
            stepper.begin();
            dap = await handler.recover(dap, (p) => stepper.progress(p));
            stepper.done();

            // Middle steps (Flash / Verify)
            if (middle) {
                dap = await middle({ handler, dap, session, stepper });
            }

            // Step: Reset
            stepper.begin();
            await handler.reset(dap);
            stepper.done();

            log('Disconnecting...', 'info');
            await session.dispose();
            ctx.updateStatus('Operation completed', true, false);
            log(`=== ${title} Completed Successfully ===`, 'success');

            // Notify user to manually reconnect RTT if it was connected before
            if (wasRttConnected) {
                log(`RTT was disconnected for ${title.toLowerCase()} operation. Click "Connect RTT" to reconnect.`, 'info');
            }

        } catch (error) {
            log(`Error: ${error.message}`, 'error');
            failStep(stepIdx);
            ctx.updateStatus('Operation failed', false, false);
        } finally {
            await session.dispose();

            ctx.setButtonsEnabled(true);

            operationLock.release(type);

            // Ensure StateManager is properly cleaned up
            stateManager.setRttConnected(false);
            stateManager.setDeviceConnected(false);
            stateManager.setRttComponents(null, null);
            stateManager.stopPolling();

            scheduleStepReset();
        }
    }

    async function runFlash() {
        const parsedFirmware = ctx.getParsedFirmware();
        if (!parsedFirmware) {
            log('Please select a firmware file first', 'warning');
            return;
        }

        const verify = ctx.dom.verifyCheckbox.checked && targetManager.hasCapability('verify');
        const steps = verify ? [...FLASH_STEPS_VERIFY] : [...FLASH_STEPS_NO_VERIFY];

        await runOperation({
            type: 'FLASH',
            title: 'Flash',
            steps,
            middle: async ({ handler, dap, session, stepper }) => {
                log(`Firmware: ${parsedFirmware.size} bytes at 0x${parsedFirmware.startAddress.toString(16)}`, 'info');

                // Step: Flash
                stepper.begin();
                log('Creating fresh DAP connection for flashing...', 'info');
                const transport = session.getTransport();
                await dap.disconnect();
                session.untrack(dap);
                await sleep(DAP_RECONNECT_DELAY_MS);
                const flashDap = session.track(await handler.createFreshDap(transport));
                await sleep(DAP_RECONNECT_DELAY_MS);

                await handler.flash(flashDap, parsedFirmware.data, parsedFirmware.startAddress,
                    (p) => stepper.progress(p, `Flashing: ${Math.round(p)}%`));
                stepper.done();

                // Step: Verify (optional)
                if (verify) {
                    stepper.begin();
                    const result = await handler.verify(flashDap, parsedFirmware.data, parsedFirmware.startAddress,
                        (p) => stepper.progress(p, `Verifying: ${Math.round(p)}%`));
                    if (!result.success) {
                        throw new Error(`Verification failed: ${result.mismatches} mismatches`);
                    }
                    stepper.done();
                }

                return flashDap;
            }
        });
    }

    async function runRecover() {
        await runOperation({
            type: 'RECOVER',
            title: 'Recover',
            steps: [...RECOVER_STEPS]
        });
    }

    return { runFlash, runRecover };
}
