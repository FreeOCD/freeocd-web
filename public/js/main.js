// FreeOCD WebDebugger - Main application logic
//
// This is the entry point for the FreeOCD WebDebugger application. It handles:
// - UI initialization and event binding
// - Device connection via WebUSB
// - Flash and recover operations with step-by-step progress
// - RTT (Real-Time Transfer) terminal communication
// - Operation locking to prevent conflicting operations
// - State management for device and RTT connections

import { TargetManager } from './platform/target-manager.js';
import { WebUSBTransport } from './transport/webusb-transport.js';
import { parseIntelHex } from './core/hex-parser.js';
import { sleep } from './core/dap-operations.js';
import { RTTHandler } from './core/rtt-handler.js';
import { Terminal } from './core/terminal.js';
import { StateManager } from './core/state-manager.js';
import { loadProbeFilters } from './core/probe-filters.js';

// =============================================================================
// State
// =============================================================================

// Operation Lock Manager - Prevents conflicting operations
class OperationLock {
    constructor() {
        this._currentLock = null; // null, 'FLASH', 'RECOVER', 'RTT'
        this._lockOwner = null; // Description of who holds the lock
    }

    // Try to acquire a lock. Returns true if successful, false if locked by another operation
    tryAcquire(operationType, owner) {
        if (this._currentLock === null) {
            this._currentLock = operationType;
            this._lockOwner = owner;
            return true;
        }
        // Same operation can re-acquire (idempotent)
        if (this._currentLock === operationType) {
            return true;
        }
        // Different operation - lock conflict
        return false;
    }

    // Release the lock
    release(operationType) {
        if (this._currentLock === operationType) {
            this._currentLock = null;
            this._lockOwner = null;
        }
    }

    // Get current lock type
    getCurrentLock() {
        return this._currentLock;
    }

    // Check if a specific operation type is locked
    isLocked(operationType) {
        return this._currentLock !== null && this._currentLock !== operationType;
    }

    // Check if any operation is locked
    isAnyLocked() {
        return this._currentLock !== null;
    }
}

const targetManager = new TargetManager();
const stateManager = new StateManager();
const operationLock = new OperationLock();
let transport = null;
let isOperationInProgress = false;
let parsedFirmware = null;
let baseDeviceStatus = 'No device connected';

// RTT state
let rttProcessor = null;
let rttHandler = null;
let terminal = null;
let rttPollingInterval = 10; // ms (for RTT data polling, separate from StateManager polling)
let rttDataAbortController = null; // for RTT data polling loop

// Step definitions for each operation mode
const FLASH_STEPS_VERIFY = ['🔌 Connect', '🗑️ Mass Erase', '📤 Flash', '✅ Verify', '🔄 Reset'];
const FLASH_STEPS_NO_VERIFY = ['🔌 Connect', '🗑️ Mass Erase', '📤 Flash', '🔄 Reset'];
const RECOVER_STEPS = ['🔌 Connect', '🗑️ Mass Erase', '🔄 Reset'];

// =============================================================================
// DOM References
// =============================================================================

const dom = {
    disclaimerModal: document.getElementById('disclaimerModal'),
    mainContent: document.getElementById('mainContent'),
    btnAgree: document.getElementById('btnAgree'),
    connectionMethod: document.getElementById('connectionMethod'),
    targetSelect: document.getElementById('targetSelect'),
    hexFile: document.getElementById('hexFile'),
    verifyCheckbox: document.getElementById('verifyCheckbox'),
    verifyRow: document.getElementById('verifyRow'),
    skipProbeCheckCheckbox: document.getElementById('skipProbeCheckCheckbox'),
    skipProbeCheckRow: document.getElementById('skipProbeCheckRow'),
    unknownProbeWarning: document.getElementById('unknownProbeWarning'),
    autoScrollCheckbox: null,
    btnFlash: document.getElementById('btnFlash'),
    btnRecover: document.getElementById('btnRecover'),
    flasherSection: document.getElementById('flasherSection'),
    rttSection: document.getElementById('rttSection'),
    statusIndicator: document.getElementById('statusIndicator'),
    deviceStatus: document.getElementById('deviceStatus'),
    stepPreview: document.getElementById('stepPreview'),
    stepPreviewList: document.getElementById('stepPreviewList'),
    stepProgress: document.getElementById('stepProgress'),
    stepList: document.getElementById('stepList'),
    logEl: document.getElementById('log'),
    logContainer: document.querySelector('.log-container'),
    fileInfo: document.getElementById('fileInfo'),
    fileName: document.getElementById('fileName'),
    fileHash: document.getElementById('fileHash'),
    fileSize: document.getElementById('fileSize'),
    // RTT elements
    rttPanel: document.getElementById('rttPanel'),
    rttConnectBtn: document.getElementById('rttConnectBtn'),
    rttSettingsToggle: document.getElementById('rttSettingsToggle'),
    rttSettingsContent: document.getElementById('rttSettingsContent'),
    rttScanStart: document.getElementById('rttScanStart'),
    rttScanRange: document.getElementById('rttScanRange'),
    rttPollingInterval: document.getElementById('rttPollingInterval'),
    rttTerminalContainer: document.getElementById('rttTerminalContainer'),
    // Utility buttons
    btnSoftReset: document.getElementById('btnSoftReset'),
    btnHardReset: document.getElementById('btnHardReset'),
    // Advanced debug elements
    advancedDebugToggle: document.getElementById('advancedDebugToggle'),
    advancedDebugContent: document.getElementById('advancedDebugContent'),
    btnReadDeviceId: document.getElementById('btnReadDeviceId'),
    btnHalt: document.getElementById('btnHalt'),
    btnResume: document.getElementById('btnResume'),
    btnGetCoreState: document.getElementById('btnGetCoreState'),
    // Memory operations
    memReadAddress: document.getElementById('memReadAddress'),
    memReadLength: document.getElementById('memReadLength'),
    btnReadMemory: document.getElementById('btnReadMemory'),
    memWriteAddress: document.getElementById('memWriteAddress'),
    memWriteData: document.getElementById('memWriteData'),
    btnWriteMemory: document.getElementById('btnWriteMemory'),
    // SWJ control
    swjPinOutput: document.getElementById('swjPinOutput'),
    swjPinSelect: document.getElementById('swjPinSelect'),
    swjPinWait: document.getElementById('swjPinWait'),
    btnControlSwjPins: document.getElementById('btnControlSwjPins'),
    swjClock: document.getElementById('swjClock'),
    btnSetSwjClock: document.getElementById('btnSetSwjClock')
};

// =============================================================================
// File Hash Calculation
// =============================================================================

async function calculateSHA256(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    return hashHex;
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function formatTime(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

// =============================================================================
// Logging
// =============================================================================

function log(message, type = 'info') {
    const timestamp = new Date().toLocaleTimeString();
    const span = document.createElement('span');
    span.className = `log-${type}`;
    span.textContent = `[${timestamp}] ${message}\n`;
    dom.logEl.appendChild(span);
    const shouldAutoScroll = dom.autoScrollCheckbox ? dom.autoScrollCheckbox.checked : true;
    if (shouldAutoScroll) {
        dom.logContainer.scrollTop = dom.logContainer.scrollHeight;
    }
}

function clearLog() {
    dom.logEl.innerHTML = '';
}

// =============================================================================
// StateManager Initialization
// =============================================================================

// Initialize StateManager with callbacks
stateManager.setCallbacks({
    onLog: (message, type) => log(message, type),
    onUpdateStatus: (status, connected, busy, operationName, progress) => {
        updateStatus(status, connected, busy, operationName, progress);
    },
    onCleanup: async () => {
        // Trigger cleanup when error is detected
        await cleanupRtt();
    }
});

// Set up StateManager event listeners
stateManager.on('stateChange', (_state) => {
    // Update UI based on state changes
    updateUtilityButtons();
});

stateManager.on('rttConnected', () => {
    dom.rttConnectBtn.textContent = '⏹️ Disconnect RTT';
});

stateManager.on('rttDisconnected', () => {
    dom.rttConnectBtn.textContent = '▶️ Connect RTT';
    // Button state is updated in disconnectRtt()
});

stateManager.on('deviceConnected', () => {
    // Device connected state
});

stateManager.on('deviceDisconnected', () => {
    // Device disconnected state
});

stateManager.on('error', (_error) => {
    // Error handling
});

// =============================================================================
// Status
// =============================================================================

function updateStatus(status, connected = false, busy = false, operationName = null, progress = null) {
    // Update base device status (without operation info)
    baseDeviceStatus = status;

    dom.statusIndicator.className = 'status-indicator';
    if (busy) {
        dom.statusIndicator.classList.add('status-busy');
    } else if (connected) {
        dom.statusIndicator.classList.add('status-connected');
    } else {
        dom.statusIndicator.classList.add('status-disconnected');
    }

    // Update device status with operation info if busy
    if (busy && operationName) {
        if (progress !== null) {
            dom.deviceStatus.textContent = `${status} - ${operationName}: ${Math.round(progress)}%`;
        } else {
            dom.deviceStatus.textContent = `${status} - ${operationName}`;
        }
    } else {
        dom.deviceStatus.textContent = status;
    }
}

function setButtonsEnabled(enabled) {
    const currentLock = operationLock.getCurrentLock();
    const hasTarget = dom.targetSelect.value !== '';
    const hasFirmware = parsedFirmware !== null;

    // Flash requires both a target and a firmware file.
    dom.btnFlash.disabled = !enabled || !hasTarget || !hasFirmware || currentLock === 'RTT';
    // Recover performs a mass erase and does not consume the firmware file, so
    // it must stay available whenever a recover-capable target is selected.
    dom.btnRecover.disabled = !enabled || !hasTarget || currentLock === 'RTT';

    // RTT button: disabled if Flash/Recover operation is in progress
    dom.rttConnectBtn.disabled = (currentLock === 'FLASH' || currentLock === 'RECOVER');
}

// =============================================================================
// Step Preview (before execution)
// =============================================================================

// Toggle target-capability-dependent UI elements.
//
// The entire Flasher section, Recover button, Verify checkbox row, and the
// entire RTT section are shown only when the currently loaded target declares
// the matching capability. If no target is loaded, `getCapabilities()` returns
// the default `['flash']` fallback, so the Flasher section stays visible (with
// the Flash button kept disabled via setButtonsEnabled() until both a target
// and a firmware file are selected) while the Recover button, Verify row, and
// RTT section remain hidden.
function applyCapabilityGates() {
    const hasFlash = targetManager.hasCapability('flash');
    const hasRecover = targetManager.hasCapability('recover');
    const hasVerify = targetManager.hasCapability('verify');
    const hasRtt = targetManager.hasCapability('rtt');

    // All four DOM references are looked up at import time; they may be null if
    // the HTML is restructured, so guard each access consistently.
    if (dom.flasherSection) {
        dom.flasherSection.classList.toggle('hidden', !hasFlash);
    }
    if (dom.btnRecover) {
        dom.btnRecover.classList.toggle('hidden', !hasRecover);
    }
    if (dom.verifyRow) {
        dom.verifyRow.classList.toggle('hidden', !hasVerify);
    }
    if (dom.rttSection) {
        dom.rttSection.classList.toggle('hidden', !hasRtt);
    }
}

function updateStepPreview() {
    const hasFile = parsedFirmware !== null;
    const verify = dom.verifyCheckbox.checked && targetManager.hasCapability('verify');

    // Build preview for Flash operation
    let steps;
    if (hasFile) {
        steps = verify ? FLASH_STEPS_VERIFY : FLASH_STEPS_NO_VERIFY;
    } else {
        steps = ['Select a firmware file to see steps'];
    }

    renderStepPreview(steps);
}

function renderStepPreview(steps) {
    dom.stepPreviewList.innerHTML = '';
    steps.forEach((step, i) => {
        if (i > 0) {
            const arrow = document.createElement('span');
            arrow.className = 'step-preview-arrow';
            arrow.textContent = '→';
            dom.stepPreviewList.appendChild(arrow);
        }
        const item = document.createElement('span');
        item.className = 'step-preview-item';
        item.textContent = `${i + 1}. ${step}`;
        dom.stepPreviewList.appendChild(item);
    });
}

// =============================================================================
// Step Progress (during execution)
// =============================================================================

let currentSteps = [];
let currentStepIndex = -1;
let operationStartTime = null;
let stepStartTimes = [];
let stepResetTimerId = null; // Track the timer for resetting step progress

function initStepProgress(steps) {
    // Cancel any pending reset timer from previous operation
    if (stepResetTimerId !== null) {
        clearTimeout(stepResetTimerId);
        stepResetTimerId = null;
    }

    currentSteps = steps;
    currentStepIndex = -1;
    operationStartTime = Date.now();
    stepStartTimes = new Array(steps.length).fill(null);
    dom.stepProgress.classList.add('visible');
    dom.stepPreview.style.display = 'none';

    dom.stepList.innerHTML = '';
    steps.forEach((step, i) => {
        const li = document.createElement('li');
        li.className = 'step-item';
        li.id = `step-${i}`;
        li.innerHTML = `
            <div class="step-indicator">${i + 1}</div>
            <div class="step-content">
                <span class="step-name">${step}</span>
                <div class="step-progress-bar">
                    <div class="step-progress-fill" id="step-fill-${i}"></div>
                </div>
                <div class="step-progress-text" id="step-text-${i}"></div>
            </div>
        `;
        dom.stepList.appendChild(li);
    });
}

function activateStep(index) {
    if (currentStepIndex >= 0 && currentStepIndex < currentSteps.length) {
        const prevEl = document.getElementById(`step-${currentStepIndex}`);
        if (prevEl && !prevEl.classList.contains('error')) {
            prevEl.classList.remove('active');
            prevEl.classList.add('completed');
            const indicator = prevEl.querySelector('.step-indicator');
            if (indicator) indicator.textContent = '✓';
        }
    }
    currentStepIndex = index;
    if (index < stepStartTimes.length) {
        stepStartTimes[index] = Date.now();
    }
    if (index < currentSteps.length) {
        const el = document.getElementById(`step-${index}`);
        if (el) el.classList.add('active');
        // Update status bar with current step name
        const isConnected = dom.statusIndicator.classList.contains('status-connected');
        updateStatus(baseDeviceStatus, isConnected, true, currentSteps[index], 0);
    }
}

function updateStepProgress(index, percent, text) {
    const fill = document.getElementById(`step-fill-${index}`);
    const textEl = document.getElementById(`step-text-${index}`);
    if (fill) fill.style.width = `${percent}%`;

    let displayText = text || `${Math.round(percent)}%`;

    // Calculate elapsed and remaining time based on individual step start time
    const startTime = stepStartTimes[index] || operationStartTime;
    if (startTime && percent > 0) {
        const elapsed = (Date.now() - startTime) / 1000;
        displayText += ` (${formatTime(elapsed)} elapsed`;

        // Show remaining time only after 1s to avoid wild estimates
        if (elapsed >= 1) {
            const remaining = (elapsed / percent) * (100 - percent);
            if (remaining > 0) {
                displayText += `, ~${formatTime(remaining)} remaining`;
            }
        }
        displayText += ')';
    }

    if (textEl) textEl.textContent = displayText;

    // Update status bar with progress if this is the active step
    if (index === currentStepIndex && index < currentSteps.length) {
        const isConnected = dom.statusIndicator.classList.contains('status-connected');
        updateStatus(baseDeviceStatus, isConnected, true, currentSteps[index], percent);
    }
}

function completeStep(index) {
    const el = document.getElementById(`step-${index}`);
    if (el) {
        el.classList.remove('active');
        el.classList.add('completed');
        const indicator = el.querySelector('.step-indicator');
        if (indicator) indicator.textContent = '✓';
    }
}

function failStep(index) {
    const el = document.getElementById(`step-${index}`);
    if (el) {
        el.classList.remove('active');
        el.classList.add('error');
        const indicator = el.querySelector('.step-indicator');
        if (indicator) indicator.textContent = '✗';
    }
}

function resetStepProgress() {
    // Clear the timer ID since this function was called
    stepResetTimerId = null;

    dom.stepProgress.classList.remove('visible');
    dom.stepPreview.style.display = '';
    currentSteps = [];
    currentStepIndex = -1;
    operationStartTime = null;
    stepStartTimes = [];
}

// =============================================================================
// RTT Operations
// =============================================================================

async function connectRtt() {
    // Check operation lock
    if (!operationLock.tryAcquire('RTT', 'connectRtt')) {
        const currentLock = operationLock.getCurrentLock();
        log(`Cannot connect RTT: ${currentLock} operation is in progress`, 'warning');
        return;
    }

    const state = stateManager.getState();
    if (state.isRttConnected) {
        operationLock.release('RTT');
        return;
    }

    try {
        log('=== RTT Connection ===', 'info');
        updateStatus('Selecting device for RTT...', false, true, 'Connecting RTT');

        transport = new WebUSBTransport();
        await transport.selectDevice(targetManager.getUsbFilters(), getSelectDeviceOptions());

        const deviceName = transport.getDeviceName();
        log(`Device selected: ${deviceName}`, 'success');

        // Create CortexM processor for RTT
        rttProcessor = new DAPjs.CortexM(transport.getTransport());
        await rttProcessor.connect();
        log('DAP connected for RTT', 'success');

        // Halt and reset to ensure clean state
        await rttProcessor.softReset();
        await sleep(1000);
        await rttProcessor.halt();

        // Get RTT settings
        const scanStart = parseInt(dom.rttScanStart.value, 16) || 0x20000000;
        const scanRange = parseInt(dom.rttScanRange.value, 16) || 0x10000;
        rttPollingInterval = parseInt(dom.rttPollingInterval.value) || 1;

        log(`Scanning for RTT at 0x${scanStart.toString(16)} (range: 0x${scanRange.toString(16)})`, 'info');

        // Initialize RTT handler
        rttHandler = new RTTHandler(rttProcessor, {
            scanStartAddress: scanStart,
            scanRange: scanRange
        });

        const numBufs = await rttHandler.init();
        if (numBufs < 0) {
            throw new Error('RTT control block not found');
        }

        log(`RTT initialized: ${numBufs} buffers found`, 'success');

        // Resume target
        await rttProcessor.resume();

        // Set components in StateManager
        stateManager.setRttComponents(rttProcessor, rttHandler);

        // Enable terminal (already initialized in init())
        if (terminal) {
            terminal.enable();
            terminal.focus();
        }

        // Start StateManager polling (1 second interval for state monitoring)
        stateManager.startPolling();

        // Start RTT data polling using the user-configurable interval
        // (`rttPollingInterval` above; default 10ms per the HTML input).
        startRttDataPolling();

        // Set RTT connected state in StateManager
        stateManager.setRttConnected(true);
        stateManager.setDeviceConnected(true);

        updateStatus(`RTT Connected: ${deviceName}`, true, false);

        // Disable Flash/Recover buttons, enable utility buttons
        setButtonsEnabled(false);
        updateUtilityButtons();

        log('=== RTT Connected Successfully ===', 'success');

    } catch (error) {
        log(`RTT connection error: ${error.message}`, 'error');
        updateStatus('RTT connection failed', false, false);
        await cleanupRtt();
        operationLock.release('RTT');
    }
}

async function disconnectRtt() {
    const state = stateManager.getState();
    if (!state.isRttConnected) {
        return;
    }

    log('Disconnecting RTT...', 'info');

    // Stop StateManager polling
    stateManager.stopPolling();

    // Stop RTT data polling
    stopRttDataPolling();

    await cleanupRtt();

    // Update StateManager state
    stateManager.setRttConnected(false);
    stateManager.setDeviceConnected(false);

    // Release operation lock
    operationLock.release('RTT');

    updateStatus('RTT Disconnected', false, false);

    // Explicitly enable buttons after lock is released
    setButtonsEnabled(true);

    log('RTT disconnected', 'success');
}

async function cleanupRtt() {
    stopRttDataPolling();
    stateManager.stopPolling();

    if (rttProcessor) {
        try {
            await rttProcessor.disconnect();
        } catch (_) { /* ignore */ }
        rttProcessor = null;
    }

    if (transport) {
        try {
            await transport.close();
        } catch (_) { /* ignore */ }
        transport = null;
    }

    rttHandler = null;

    // Clear StateManager components
    stateManager.setRttComponents(null, null);

    if (terminal) {
        terminal.disable();
    }
}

function startRttDataPolling() {
    if (rttDataAbortController) {
        return;
    }

    rttDataAbortController = new AbortController();

    async function pollLoop() {
        while (!rttDataAbortController.signal.aborted) {
            try {
                const state = stateManager.getState();
                if (rttHandler && state.isRttConnected) {
                    // Read from target
                    const data = await rttHandler.read(0);
                    if (data.length > 0) {
                        const text = new TextDecoder().decode(data);
                        if (terminal) {
                            terminal.write(text, 'output');
                        }
                    }

                    // Update buffer info
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

async function sendToRtt(data) {
    const state = stateManager.getState();
    if (!rttHandler || !state.isRttConnected) {
        return;
    }

    try {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(data);
        const result = await rttHandler.write(0, bytes);
        if (result < 0) {
            log('RTT buffer full, data not sent', 'warning');
        }
    } catch (error) {
        log(`RTT send error: ${error.message}`, 'error');
    }
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

// =============================================================================
// Utility Functions
// =============================================================================

async function performSoftReset() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
        log('Performing soft reset...', 'info');
        await rttProcessor.softReset();
        await sleep(500);
        log('Soft reset completed', 'success');
    } catch (error) {
        log(`Soft reset failed: ${error.message}`, 'error');
    }
}

async function performHardReset() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
        log('Performing hard reset...', 'info');
        await rttProcessor.reset();
        await sleep(500);
        log('Hard reset completed', 'success');
    } catch (error) {
        log(`Hard reset failed: ${error.message}`, 'error');
    }
}

async function readDeviceInfo() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
        log('Reading device information...', 'info');

        // Get CMSIS-DAP proxy from processor
        const proxy = rttProcessor;
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
                const result = await proxy.dapInfo(info.request);
                log(`${info.name}: ${result}`, 'info');
            } catch (_) {
                log(`${info.name}: Not available`, 'warning');
            }
        }

        log('Device information read completed', 'success');
    } catch (error) {
        log(`Read device info failed: ${error.message}`, 'error');
    }
}

async function performHalt() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
        log('Halting CPU...', 'info');
        await rttProcessor.halt();
        log('CPU halted', 'success');
    } catch (error) {
        log(`Halt failed: ${error.message}`, 'error');
    }
}

async function performResume() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
        log('Resuming CPU...', 'info');
        await rttProcessor.resume();
        log('CPU resumed', 'success');
    } catch (error) {
        log(`Resume failed: ${error.message}`, 'error');
    }
}

async function getCoreState() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
        log('Reading core state...', 'info');
        const state = await rttProcessor.getState();
        const stateNames = ['RESET', 'LOCKUP', 'SLEEPING', 'DEBUG', 'RUNNING'];
        log(`Core state: ${stateNames[state]}`, 'success');
    } catch (error) {
        log(`Get core state failed: ${error.message}`, 'error');
    }
}

async function readMemory() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
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
        const data = await rttProcessor.readBytes(address, length);

        // Display as hex
        const hexArray = Array.from(data).map(b => b.toString(16).padStart(2, '0').toUpperCase());
        const hexString = hexArray.join(' ');
        log(`Memory data: ${hexString}`, 'success');
    } catch (error) {
        log(`Read memory failed: ${error.message}`, 'error');
    }
}

async function writeMemory() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
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
            await rttProcessor.writeMem8(address + i, hexBytes[i]);
        }

        log('Memory write completed', 'success');
    } catch (error) {
        log(`Write memory failed: ${error.message}`, 'error');
    }
}

async function controlSwjPins() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
        const pinOutput = parseInt(dom.swjPinOutput.value, 16);
        const pinSelect = parseInt(dom.swjPinSelect.value, 16);
        const pinWait = parseInt(dom.swjPinWait.value);

        if (isNaN(pinOutput) || isNaN(pinSelect) || isNaN(pinWait)) {
            log('Invalid pin values', 'error');
            return;
        }

        log(`Controlling SWJ pins (output: 0x${pinOutput.toString(16)}, select: 0x${pinSelect.toString(16)}, wait: ${pinWait}μs)...`, 'info');

        const result = await rttProcessor.swjPins(pinOutput, pinSelect, pinWait);
        log(`Pin state after control: 0x${result.toString(16)}`, 'success');
    } catch (error) {
        log(`Control SWJ pins failed: ${error.message}`, 'error');
    }
}

async function setSwjClock() {
    const state = stateManager.getState();
    if (!state.isRttConnected || !rttProcessor) {
        log('No RTT connection', 'error');
        return;
    }

    try {
        const clock = parseInt(dom.swjClock.value);

        if (isNaN(clock) || clock <= 0) {
            log('Invalid clock frequency', 'error');
            return;
        }

        log(`Setting SWJ clock to ${clock} Hz...`, 'info');
        await rttProcessor.swjClock(clock);
        log('SWJ clock set completed', 'success');
    } catch (error) {
        log(`Set SWJ clock failed: ${error.message}`, 'error');
    }
}

function updateUtilityButtons() {
    const state = stateManager.getState();
    const connected = state.isRttConnected && rttProcessor !== null;
    const currentLock = operationLock.getCurrentLock();

    dom.btnSoftReset.disabled = !connected;
    dom.btnHardReset.disabled = !connected;
    dom.btnReadDeviceId.disabled = !connected;
    dom.btnHalt.disabled = !connected;
    dom.btnResume.disabled = !connected;
    dom.btnGetCoreState.disabled = !connected;
    dom.btnReadMemory.disabled = !connected;
    dom.btnWriteMemory.disabled = !connected;
    dom.btnControlSwjPins.disabled = !connected;
    dom.btnSetSwjClock.disabled = !connected;

    // Update RTT button based on lock state
    dom.rttConnectBtn.disabled = (currentLock === 'FLASH' || currentLock === 'RECOVER');
}

// =============================================================================
// Operations
// =============================================================================

async function runFlash() {
    // Check operation lock
    if (!operationLock.tryAcquire('FLASH', 'runFlash')) {
        const currentLock = operationLock.getCurrentLock();
        log(`Cannot start Flash: ${currentLock} operation is in progress`, 'warning');
        return;
    }

    if (isOperationInProgress) return;
    if (!parsedFirmware) {
        operationLock.release('FLASH');
        log('Please select a firmware file first', 'warning');
        return;
    }

    // If step progress is already visible, clear it immediately
    if (dom.stepProgress.classList.contains('visible')) {
        log('Clearing previous operation progress...', 'info');
        if (stepResetTimerId !== null) {
            clearTimeout(stepResetTimerId);
            stepResetTimerId = null;
        }
        resetStepProgress();
    }

    // Disconnect RTT if connected
    const state = stateManager.getState();
    const wasRttConnected = state.isRttConnected;
    if (state.isRttConnected) {
        log('RTT is connected, disconnecting for flash operation...', 'info');
        await disconnectRtt();
    }

    // Stop StateManager polling during Flash operation
    stateManager.setExternalOperationInProgress(true);
    stateManager.stopPolling();

    clearLog();
    isOperationInProgress = true;
    setButtonsEnabled(false);

    const verify = dom.verifyCheckbox.checked && targetManager.hasCapability('verify');
    const steps = verify ? [...FLASH_STEPS_VERIFY] : [...FLASH_STEPS_NO_VERIFY];
    initStepProgress(steps);

    let dap = null;
    let stepIdx = 0;

    try {
        // Step: Connect
        activateStep(stepIdx);
        log('=== Flash Operation ===', 'info');
        log(`Firmware: ${parsedFirmware.size} bytes at 0x${parsedFirmware.startAddress.toString(16)}`, 'info');

        updateStatus('Selecting device...', false, true, 'Connecting');
        transport = new WebUSBTransport();
        await transport.selectDevice(targetManager.getUsbFilters(), getSelectDeviceOptions());

        const deviceName = transport.getDeviceName();
        log(`Device selected: ${deviceName}`, 'success');
        updateStatus(`Connected: ${deviceName}`, true, true, 'Mass Erasing');

        const handler = targetManager.createHandler(log);
        dap = new DAPjs.ADI(transport.getTransport());
        await dap.connect();
        log('DAP connected', 'success');
        completeStep(stepIdx);
        stepIdx++;

        // Step: Mass Erase
        activateStep(stepIdx);
        dap = await handler.recover(dap, (p) => updateStepProgress(stepIdx, p));
        completeStep(stepIdx);
        stepIdx++;

        // Step: Flash
        activateStep(stepIdx);
        log('Creating fresh DAP connection for flashing...', 'info');
        await dap.disconnect();
        await sleep(200);
        const flashDap = await handler.createFreshDap(transport.getTransport());
        await sleep(200);

        await handler.flash(flashDap, parsedFirmware.data, parsedFirmware.startAddress,
            (p) => updateStepProgress(stepIdx, p, `Flashing: ${Math.round(p)}%`));
        completeStep(stepIdx);
        stepIdx++;
        dap = flashDap;

        // Step: Verify (optional)
        if (verify) {
            activateStep(stepIdx);
            const result = await handler.verify(dap, parsedFirmware.data, parsedFirmware.startAddress,
                (p) => updateStepProgress(stepIdx, p, `Verifying: ${Math.round(p)}%`));
            if (!result.success) {
                failStep(stepIdx);
                throw new Error(`Verification failed: ${result.mismatches} mismatches`);
            }
            completeStep(stepIdx);
            stepIdx++;
        }

        // Step: Reset
        activateStep(stepIdx);
        await handler.reset(dap);
        completeStep(stepIdx);

        log('Disconnecting...', 'info');
        await dap.disconnect();
        updateStatus('Operation completed', true, false);
        log('=== Flash Completed Successfully ===', 'success');

        // Notify user to manually reconnect RTT if it was connected before
        if (wasRttConnected) {
            log('RTT was disconnected for flash operation. Click "Connect RTT" to reconnect.', 'info');
        }

    } catch (error) {
        log(`Error: ${error.message}`, 'error');
        failStep(stepIdx);
        updateStatus('Operation failed', false, false);
        if (dap) {
            try { await dap.disconnect(); } catch (_) { /* ignore */ }
        }
    } finally {
        isOperationInProgress = false;
        setButtonsEnabled(true);
        
        // Release operation lock
        operationLock.release('FLASH');
        
        // Reset external operation flag
        stateManager.setExternalOperationInProgress(false);
        
        // Ensure StateManager is properly cleaned up after Flash
        stateManager.setRttConnected(false);
        stateManager.setDeviceConnected(false);
        stateManager.setRttComponents(null, null);
        stateManager.stopPolling();
        
        // Schedule reset with timer tracking
        stepResetTimerId = setTimeout(resetStepProgress, 3000);
    }
}

async function runRecover() {
    // Check operation lock
    if (!operationLock.tryAcquire('RECOVER', 'runRecover')) {
        const currentLock = operationLock.getCurrentLock();
        log(`Cannot start Recover: ${currentLock} operation is in progress`, 'warning');
        return;
    }

    // If step progress is already visible, clear it immediately
    if (dom.stepProgress.classList.contains('visible')) {
        log('Clearing previous operation progress...', 'info');
        if (stepResetTimerId !== null) {
            clearTimeout(stepResetTimerId);
            stepResetTimerId = null;
        }
        resetStepProgress();
    }

    // Disconnect RTT if connected
    const state = stateManager.getState();
    const wasRttConnected = state.isRttConnected;
    if (state.isRttConnected) {
        log('RTT is connected, disconnecting for recover operation...', 'info');
        await disconnectRtt();
    }

    clearLog();
    isOperationInProgress = true;
    setButtonsEnabled(false);
    
    // Set external operation flag to prevent StateManager polling interference
    stateManager.setExternalOperationInProgress(true);
    stateManager.stopPolling();

    const steps = [...RECOVER_STEPS];
    initStepProgress(steps);

    let dap = null;
    let stepIdx = 0;

    try {
        // Step: Connect
        activateStep(stepIdx);
        log('=== Recover (Mass Erase) Operation ===', 'info');

        updateStatus('Selecting device...', false, true, 'Connecting');
        transport = new WebUSBTransport();
        await transport.selectDevice(targetManager.getUsbFilters(), getSelectDeviceOptions());

        const deviceName = transport.getDeviceName();
        log(`Device selected: ${deviceName}`, 'success');
        updateStatus(`Connected: ${deviceName}`, true, true, 'Mass Erasing');

        const handler = targetManager.createHandler(log);
        dap = new DAPjs.ADI(transport.getTransport());
        await dap.connect();
        log('DAP connected', 'success');
        completeStep(stepIdx);
        stepIdx++;

        // Step: Mass Erase
        activateStep(stepIdx);
        dap = await handler.recover(dap, (p) => updateStepProgress(stepIdx, p));
        completeStep(stepIdx);
        stepIdx++;

        // Step: Reset
        activateStep(stepIdx);
        await handler.reset(dap);
        completeStep(stepIdx);

        log('Disconnecting...', 'info');
        await dap.disconnect();
        updateStatus('Operation completed', true, false);
        log('=== Recover Completed Successfully ===', 'success');

        // Notify user to manually reconnect RTT if it was connected before
        if (wasRttConnected) {
            log('RTT was disconnected for recover operation. Click "Connect RTT" to reconnect.', 'info');
        }

    } catch (error) {
        log(`Error: ${error.message}`, 'error');
        failStep(stepIdx);
        updateStatus('Operation failed', false, false);
        if (dap) {
            try { await dap.disconnect(); } catch (_) { /* ignore */ }
        }
    } finally {
        isOperationInProgress = false;
        setButtonsEnabled(true);
        
        // Release operation lock
        operationLock.release('RECOVER');
        
        // Reset external operation flag
        stateManager.setExternalOperationInProgress(false);
        
        // Ensure StateManager is properly cleaned up after Recover
        stateManager.setRttConnected(false);
        stateManager.setDeviceConnected(false);
        stateManager.setRttComponents(null, null);
        stateManager.stopPolling();
        
        // Schedule reset with timer tracking
        stepResetTimerId = setTimeout(resetStepProgress, 3000);
    }
}

// =============================================================================
// Event Handlers
// =============================================================================

function checkDisclaimerConsent() {
    const STORAGE_KEY = 'freeocd_disclaimer_accepted';
    const CONSENT_DURATION_DAYS = 30;

    try {
        const stored = localStorage.getItem(STORAGE_KEY);
        if (stored) {
            const data = JSON.parse(stored);
            const now = Date.now();
            const daysSinceConsent = (now - data.timestamp) / (1000 * 60 * 60 * 24);

            if (daysSinceConsent < CONSENT_DURATION_DAYS) {
                // Valid consent within 30 days
                dom.disclaimerModal.classList.add('hidden');
                dom.mainContent.classList.remove('disabled');
                return true;
            } else {
                // Consent expired, remove it
                localStorage.removeItem(STORAGE_KEY);
            }
        }
    } catch (error) {
        // If localStorage fails, show modal
        console.warn('Failed to check disclaimer consent:', error);
    }

    // No valid consent, show modal
    return false;
}

function onDisclaimerAccept() {
    const STORAGE_KEY = 'freeocd_disclaimer_accepted';

    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
            timestamp: Date.now()
        }));
    } catch (error) {
        console.warn('Failed to save disclaimer consent:', error);
    }

    dom.disclaimerModal.classList.add('hidden');
    dom.mainContent.classList.remove('disabled');
}

async function onTargetChange() {
    const targetId = dom.targetSelect.value;
    if (!targetId) {
        setButtonsEnabled(false);
        applyCapabilityGates();
        renderStepPreview(['Select a target to see steps']);
        return;
    }

    try {
        await targetManager.loadTarget(targetId);
        log(`Target loaded: ${targetManager.currentTarget.name}`, 'info');
        // Persist the selection only after a successful load so we never stash
        // a broken ID that would silently fail to restore on next reload.
        try {
            localStorage.setItem('freeocd_last_target', targetId);
        } catch (error) {
            console.warn('Failed to save last target:', error);
        }
        applyCapabilityGates();
        updateStepPreview();
        // Recover only needs a target, so enable buttons whenever no operation
        // is in progress; setButtonsEnabled() evaluates per-button prerequisites.
        setButtonsEnabled(true);
    } catch (error) {
        log(`Failed to load target: ${error.message}`, 'error');
        // Drop any stale target state so the capability gates, the platform
        // handler, and the step preview do not keep reflecting the previously
        // loaded target. Reset the <select> to the "no target" placeholder and
        // clear the persisted last-target so the failing ID is not restored on
        // next reload.
        targetManager.clearCurrentTarget();
        dom.targetSelect.value = '';
        try {
            localStorage.removeItem('freeocd_last_target');
        } catch (storageError) {
            console.warn('Failed to clear last target:', storageError);
        }
        applyCapabilityGates();
        setButtonsEnabled(false);
        renderStepPreview(['Select a target to see steps']);
    }
}

function onFileChange(event) {
    const file = event.target.files[0];
    if (!file) {
        parsedFirmware = null;
        dom.fileName.textContent = '-';
        dom.fileHash.textContent = '-';
        dom.fileSize.textContent = '-';
        updateStepPreview();
        // Flash is disabled internally via missing firmware, but Recover stays
        // available when a recover-capable target is selected.
        setButtonsEnabled(true);
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            parsedFirmware = parseIntelHex(e.target.result);
            log(`HEX file loaded: ${parsedFirmware.size} bytes, start: 0x${parsedFirmware.startAddress.toString(16)}`, 'success');

            // Calculate hash and display file info
            const hash = await calculateSHA256(parsedFirmware.data);

            dom.fileName.textContent = file.name;
            dom.fileHash.textContent = hash;
            dom.fileSize.textContent = `${formatFileSize(file.size)} (${formatFileSize(parsedFirmware.size)} actual)`;

            updateStepPreview();
            if (dom.targetSelect.value) {
                setButtonsEnabled(true);
            }
        } catch (error) {
            log(`HEX parse error: ${error.message}`, 'error');
            parsedFirmware = null;
            dom.fileName.textContent = '-';
            dom.fileHash.textContent = '-';
            dom.fileSize.textContent = '-';
            // Flash is disabled internally via missing firmware, but Recover stays
            // available when a recover-capable target is selected.
            setButtonsEnabled(true);
        }
    };
    reader.readAsText(file);
}

function onVerifyChange() {
    try {
        localStorage.setItem('freeocd_verify', dom.verifyCheckbox.checked);
    } catch (error) {
        console.warn('Failed to save verify setting:', error);
    }
    updateStepPreview();
}

// Toggle the "probe identification checks disabled" warning box shown above
// the Steps preview. The warning is only relevant when the skip-probe-check
// checkbox is enabled; otherwise it stays hidden.
function updateUnknownProbeWarning() {
    if (!dom.unknownProbeWarning || !dom.skipProbeCheckCheckbox) return;
    const enabled = dom.skipProbeCheckCheckbox.checked;
    dom.unknownProbeWarning.classList.toggle('hidden', !enabled);
}

function onSkipProbeCheckChange() {
    try {
        localStorage.setItem(
            'freeocd_skip_probe_check',
            dom.skipProbeCheckCheckbox.checked
        );
    } catch (error) {
        console.warn('Failed to save skip probe check setting:', error);
    }
    updateUnknownProbeWarning();
}

// Build the options object forwarded to `transport.selectDevice()`. Kept in
// one place so every call site (Flash / Recover / RTT) consistently honors
// the skip-probe-check checkbox.
function getSelectDeviceOptions() {
    return {
        skipProbeCheck: dom.skipProbeCheckCheckbox
            ? dom.skipProbeCheckCheckbox.checked
            : false
    };
}

// =============================================================================
// Initialization
// =============================================================================

async function init() {
    // Check if user has already accepted disclaimer
    checkDisclaimerConsent();

    // Initialize autoScrollCheckbox reference
    dom.autoScrollCheckbox = document.getElementById('autoScrollCheckbox');

    // Restore verify checkbox state
    try {
        const verifyState = localStorage.getItem('freeocd_verify');
        if (verifyState !== null) {
            dom.verifyCheckbox.checked = verifyState === 'true';
        }
    } catch (error) {
        console.warn('Failed to restore verify setting:', error);
    }

    // Restore skip-probe-check checkbox state. This setting is persisted so
    // advanced users working with a non-listed probe do not have to re-enable
    // it on every page load.
    try {
        const skipProbeCheckState = localStorage.getItem('freeocd_skip_probe_check');
        if (skipProbeCheckState !== null) {
            dom.skipProbeCheckCheckbox.checked = skipProbeCheckState === 'true';
        }
    } catch (error) {
        console.warn('Failed to restore skip probe check setting:', error);
    }
    updateUnknownProbeWarning();

    // Restore autoScroll checkbox state
    try {
        const autoScrollState = localStorage.getItem('freeocd_autoscroll');
        if (autoScrollState !== null) {
            dom.autoScrollCheckbox.checked = autoScrollState === 'true';
        }
    } catch (error) {
        console.warn('Failed to restore autoscroll setting:', error);
    }

    // Restore connection method
    try {
        const connectionMethod = localStorage.getItem('freeocd_connection_method');
        if (connectionMethod) {
            dom.connectionMethod.value = connectionMethod;
        }
    } catch (error) {
        console.warn('Failed to restore connection method:', error);
    }

    // Bind events
    dom.btnAgree.addEventListener('click', onDisclaimerAccept);
    dom.targetSelect.addEventListener('change', onTargetChange);
    dom.hexFile.addEventListener('change', onFileChange);
    dom.verifyCheckbox.addEventListener('change', onVerifyChange);
    dom.skipProbeCheckCheckbox.addEventListener('change', onSkipProbeCheckChange);
    dom.autoScrollCheckbox.addEventListener('change', () => {
        try {
            localStorage.setItem('freeocd_autoscroll', dom.autoScrollCheckbox.checked);
        } catch (error) {
            console.warn('Failed to save autoscroll setting:', error);
        }
    });
    dom.connectionMethod.addEventListener('change', () => {
        try {
            localStorage.setItem('freeocd_connection_method', dom.connectionMethod.value);
        } catch (error) {
            console.warn('Failed to save connection method:', error);
        }
    });
    dom.btnFlash.addEventListener('click', runFlash);
    dom.btnRecover.addEventListener('click', runRecover);

    // Utility button events
    dom.btnSoftReset.addEventListener('click', performSoftReset);
    dom.btnHardReset.addEventListener('click', performHardReset);
    dom.btnReadDeviceId.addEventListener('click', readDeviceInfo);
    dom.btnHalt.addEventListener('click', performHalt);
    dom.btnResume.addEventListener('click', performResume);
    dom.btnGetCoreState.addEventListener('click', getCoreState);
    dom.btnReadMemory.addEventListener('click', readMemory);
    dom.btnWriteMemory.addEventListener('click', writeMemory);
    dom.btnControlSwjPins.addEventListener('click', controlSwjPins);
    dom.btnSetSwjClock.addEventListener('click', setSwjClock);

    // Prevent page navigation when device is connected or operation is in progress
    window.addEventListener('beforeunload', (e) => {
        const state = stateManager.getState();
        if (state.isRttConnected || isOperationInProgress) {
            e.preventDefault();
            e.returnValue = '';
            return '';
        }
    });

    // RTT events
    if (dom.rttConnectBtn) {
        dom.rttConnectBtn.addEventListener('click', async () => {
            const state = stateManager.getState();
            if (state.isRttConnected) {
                await disconnectRtt();
            } else {
                await connectRtt();
            }
        });

        // Collapsible settings toggle
        const rttSettingsToggle = document.getElementById('rttSettingsToggle');
        const rttSettingsContent = document.getElementById('rttSettingsContent');
        if (rttSettingsToggle && rttSettingsContent) {
            // Restore rttSettingsToggle state
            try {
                const rttSettingsCollapsed = localStorage.getItem('freeocd_rtt_settings_collapsed');
                if (rttSettingsCollapsed === 'false') {
                    rttSettingsToggle.classList.remove('collapsed');
                    rttSettingsContent.classList.remove('collapsed');
                }
            } catch (error) {
                console.warn('Failed to restore RTT settings toggle state:', error);
            }

            rttSettingsToggle.addEventListener('click', () => {
                const isCollapsed = rttSettingsToggle.classList.contains('collapsed');
                rttSettingsToggle.classList.toggle('collapsed');
                rttSettingsContent.classList.toggle('collapsed');
                try {
                    localStorage.setItem('freeocd_rtt_settings_collapsed', !isCollapsed);
                } catch (error) {
                    console.warn('Failed to save RTT settings toggle state:', error);
                }
            });
        }

        // Collapsible advanced debug toggle
        const advancedDebugToggle = document.getElementById('advancedDebugToggle');
        const advancedDebugContent = document.getElementById('advancedDebugContent');
        if (advancedDebugToggle && advancedDebugContent) {
            // Restore advancedDebugToggle state
            try {
                const advancedDebugCollapsed = localStorage.getItem('freeocd_advanced_debug_collapsed');
                if (advancedDebugCollapsed === 'false') {
                    advancedDebugToggle.classList.remove('collapsed');
                    advancedDebugContent.classList.remove('collapsed');
                }
            } catch (error) {
                console.warn('Failed to restore advanced debug toggle state:', error);
            }

            advancedDebugToggle.addEventListener('click', () => {
                const isCollapsed = advancedDebugToggle.classList.contains('collapsed');
                advancedDebugToggle.classList.toggle('collapsed');
                advancedDebugContent.classList.toggle('collapsed');
                try {
                    localStorage.setItem('freeocd_advanced_debug_collapsed', !isCollapsed);
                } catch (error) {
                    console.warn('Failed to save advanced debug toggle state:', error);
                }
            });
        }

        // Restore RTT settings
        try {
            const rttScanStart = localStorage.getItem('freeocd_rtt_scan_start');
            const rttScanRange = localStorage.getItem('freeocd_rtt_scan_range');
            const rttPolling = localStorage.getItem('freeocd_rtt_polling_interval');
            if (rttScanStart) dom.rttScanStart.value = rttScanStart;
            if (rttScanRange) dom.rttScanRange.value = rttScanRange;
            if (rttPolling) dom.rttPollingInterval.value = rttPolling;
        } catch (error) {
            console.warn('Failed to restore RTT settings:', error);
        }

        // Restore advanced debug settings
        try {
            const memReadAddr = localStorage.getItem('freeocd_mem_read_addr');
            const memReadLen = localStorage.getItem('freeocd_mem_read_len');
            const memWriteAddr = localStorage.getItem('freeocd_mem_write_addr');
            const swjPinOut = localStorage.getItem('freeocd_swj_pin_out');
            const swjPinSel = localStorage.getItem('freeocd_swj_pin_sel');
            const swjPinWait = localStorage.getItem('freeocd_swj_pin_wait');
            const swjClockVal = localStorage.getItem('freeocd_swj_clock');
            if (memReadAddr) dom.memReadAddress.value = memReadAddr;
            if (memReadLen) dom.memReadLength.value = memReadLen;
            if (memWriteAddr) dom.memWriteAddress.value = memWriteAddr;
            if (swjPinOut) dom.swjPinOutput.value = swjPinOut;
            if (swjPinSel) dom.swjPinSelect.value = swjPinSel;
            if (swjPinWait) dom.swjPinWait.value = swjPinWait;
            if (swjClockVal) dom.swjClock.value = swjClockVal;
        } catch (error) {
            console.warn('Failed to restore advanced debug settings:', error);
        }

        // Initialize utility buttons as disabled
        updateUtilityButtons();

        // Initialize terminal (even when disconnected)
        if (!terminal) {
            terminal = new Terminal(dom.rttTerminalContainer, {
                onSend: (data) => sendToRtt(data),
                onClear: () => log('Terminal cleared', 'info'),
                onSave: (text) => saveRttLog(text)
            });
            terminal.init();
            terminal.disable(); // Disable until connected
        }

        // Save RTT settings on change
        dom.rttScanStart.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_rtt_scan_start', dom.rttScanStart.value);
            } catch (error) {
                console.warn('Failed to save RTT scan start:', error);
            }
        });
        dom.rttScanRange.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_rtt_scan_range', dom.rttScanRange.value);
            } catch (error) {
                console.warn('Failed to save RTT scan range:', error);
            }
        });
        dom.rttPollingInterval.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_rtt_polling_interval', dom.rttPollingInterval.value);
            } catch (error) {
                console.warn('Failed to save RTT polling interval:', error);
            }
        });

        // Save advanced debug settings on change
        dom.memReadAddress.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_mem_read_addr', dom.memReadAddress.value);
            } catch (error) {
                console.warn('Failed to save mem read address:', error);
            }
        });
        dom.memReadLength.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_mem_read_len', dom.memReadLength.value);
            } catch (error) {
                console.warn('Failed to save mem read length:', error);
            }
        });
        dom.memWriteAddress.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_mem_write_addr', dom.memWriteAddress.value);
            } catch (error) {
                console.warn('Failed to save mem write address:', error);
            }
        });
        dom.swjPinOutput.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_swj_pin_out', dom.swjPinOutput.value);
            } catch (error) {
                console.warn('Failed to save SWJ pin output:', error);
            }
        });
        dom.swjPinSelect.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_swj_pin_sel', dom.swjPinSelect.value);
            } catch (error) {
                console.warn('Failed to save SWJ pin select:', error);
            }
        });
        dom.swjPinWait.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_swj_pin_wait', dom.swjPinWait.value);
            } catch (error) {
                console.warn('Failed to save SWJ pin wait:', error);
            }
        });
        dom.swjClock.addEventListener('change', () => {
            try {
                localStorage.setItem('freeocd_swj_clock', dom.swjClock.value);
            } catch (error) {
                console.warn('Failed to save SWJ clock:', error);
            }
        });
    }

    // Check WebUSB support
    if (!WebUSBTransport.isSupported()) {
        log('WebUSB is not supported in this browser.', 'error');
        log('Please use Chrome, Edge, or another Chromium-based browser.', 'error');
        setButtonsEnabled(false);
        updateStatus('WebUSB not supported', false, false);
        return;
    }

    log('WebUSB is supported. Ready to connect.', 'success');

    // Load the central CMSIS-DAP probe filter list. Probe vendor IDs are
    // orthogonal to the target MCU and are managed in
    // public/targets/probe-filters.json so that the whole targets/ tree can be
    // shared verbatim with sister projects (e.g. freeocd-vscode-extension).
    const probeFilters = await loadProbeFilters('./targets');
    targetManager.setProbeFilters(probeFilters);
    if (probeFilters.length === 0) {
        log('No probe filters loaded; WebUSB chooser will show all devices.', 'info');
    } else {
        const ids = probeFilters.map(f => '0x' + f.vendorId.toString(16).toUpperCase().padStart(4, '0')).join(', ');
        log(`Probe filters loaded: ${ids}`, 'info');
    }

    // Load target index
    try {
        const { targets, failedIds } = await targetManager.loadTargetIndex();
        dom.targetSelect.innerHTML = '<option value="">-- Select Target MCU --</option>';
        for (const target of targets) {
            const option = document.createElement('option');
            option.value = target.id;
            option.textContent = `${target.name} — ${target.description}`;
            dom.targetSelect.appendChild(option);
        }
        dom.targetSelect.disabled = false;
        dom.hexFile.disabled = false;
        log(`Loaded ${targets.length} target(s)`, 'info');
        if (failedIds.length > 0) {
            log(
                `Skipped ${failedIds.length} target(s) that failed to load: ${failedIds.join(', ')}. ` +
                `See browser console for details.`,
                'warning'
            );
        }

        // Restore last selected target from localStorage
        try {
            const lastTargetId = localStorage.getItem('freeocd_last_target');
            if (lastTargetId && targets.some(t => t.id === lastTargetId)) {
                dom.targetSelect.value = lastTargetId;
                await onTargetChange();
            } else {
                // No target restored, show initial message and hide
                // capability-gated UI until the user picks a target.
                applyCapabilityGates();
                renderStepPreview(['Select a target to see steps']);
            }
        } catch (error) {
            console.warn('Failed to restore last target:', error);
            applyCapabilityGates();
            renderStepPreview(['Select a target to see steps']);
        }
    } catch (error) {
        log(`Failed to load targets: ${error.message}`, 'error');
        dom.targetSelect.innerHTML = '<option value="">Failed to load targets</option>';
    }
}

init();
