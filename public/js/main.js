// FreeOCD WebDebugger - Application entry point.
//
// Wires the UI to the controllers:
// - ui/logger.js       - operation log
// - ui/step-progress.js - step preview / live progress
// - ui/settings.js     - persisted settings bindings
// - app/flash-controller.js - Flash / Recover operations
// - app/rtt-controller.js   - RTT terminal and utility operations
// - app/operation-lock.js   - single concurrency guard

import { TargetManager } from './platform/target-manager.js';
import { WebUSBTransport } from './transport/webusb-transport.js';
import { parseIntelHex } from './core/hex-parser.js';
import { StateManager } from './core/state-manager.js';
import { loadProbeFilters } from './core/probe-filters.js';
import { storage } from './core/storage.js';
import { initLogger, log } from './ui/logger.js';
import {
    initStepProgressUI,
    renderStepPreview
} from './ui/step-progress.js';
import { bindPersistedSettings, bindCollapsible } from './ui/settings.js';
import { operationLock } from './app/operation-lock.js';
import { createRttController } from './app/rtt-controller.js';
import {
    createFlashController,
    FLASH_STEPS_VERIFY,
    FLASH_STEPS_NO_VERIFY
} from './app/flash-controller.js';

// =============================================================================
// State
// =============================================================================

const targetManager = new TargetManager();
const stateManager = new StateManager();
let parsedFirmware = null;
let baseDeviceStatus = 'No device connected';

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
    autoScrollCheckbox: document.getElementById('autoScrollCheckbox'),
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
// UI module initialization
// =============================================================================

initLogger({
    element: dom.logEl,
    container: dom.logContainer,
    autoScroll: () => (dom.autoScrollCheckbox ? dom.autoScrollCheckbox.checked : true)
});

initStepProgressUI({
    elements: {
        stepPreview: dom.stepPreview,
        stepPreviewList: dom.stepPreviewList,
        stepProgress: dom.stepProgress,
        stepList: dom.stepList
    },
    onStepUpdate: (stepName, percent) => {
        const isConnected = dom.statusIndicator.classList.contains('status-connected');
        updateStatus(baseDeviceStatus, isConnected, true, stepName, percent);
    }
});

// =============================================================================
// File Hash Calculation
// =============================================================================

async function calculateSHA256(data) {
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function formatFileSize(bytes) {
    if (bytes < 1024) return `${bytes} bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

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

function updateUtilityButtons() {
    const state = stateManager.getState();
    const connected = state.isRttConnected && rttController.hasProcessor();
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
// Controllers
// =============================================================================

const controllerContext = {
    dom,
    targetManager,
    stateManager,
    getSelectDeviceOptions,
    getParsedFirmware: () => parsedFirmware,
    updateStatus,
    setButtonsEnabled,
    updateUtilityButtons
};

const rttController = createRttController(controllerContext);
const flashController = createFlashController({ ...controllerContext, rttController });

// =============================================================================
// StateManager Initialization
// =============================================================================

stateManager.setCallbacks({
    onLog: (message, type) => log(message, type),
    onCleanup: async () => {
        // Trigger cleanup when error is detected
        await rttController.cleanupRtt();
    }
});

stateManager.on('stateChange', (_state) => {
    updateUtilityButtons();
});

stateManager.on('rttConnected', () => {
    dom.rttConnectBtn.textContent = '⏹️ Disconnect RTT';
});

stateManager.on('rttDisconnected', () => {
    dom.rttConnectBtn.textContent = '▶️ Connect RTT';
    // Button state is updated in disconnectRtt()
});

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

// =============================================================================
// Event Handlers
// =============================================================================

function checkDisclaimerConsent() {
    const STORAGE_KEY = 'freeocd_disclaimer_accepted';
    const CONSENT_DURATION_DAYS = 30;

    const stored = storage.get(STORAGE_KEY);
    if (stored) {
        try {
            const data = JSON.parse(stored);
            const daysSinceConsent = (Date.now() - data.timestamp) / (1000 * 60 * 60 * 24);

            if (daysSinceConsent < CONSENT_DURATION_DAYS) {
                // Valid consent within 30 days
                dom.disclaimerModal.classList.add('hidden');
                dom.mainContent.classList.remove('disabled');
                return true;
            }
            // Consent expired, remove it
            storage.remove(STORAGE_KEY);
        } catch (error) {
            console.warn('Failed to check disclaimer consent:', error);
        }
    }

    // No valid consent, show modal
    return false;
}

function onDisclaimerAccept() {
    storage.set('freeocd_disclaimer_accepted', JSON.stringify({
        timestamp: Date.now()
    }));

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
        storage.set('freeocd_last_target', targetId);
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
        storage.remove('freeocd_last_target');
        applyCapabilityGates();
        setButtonsEnabled(false);
        renderStepPreview(['Select a target to see steps']);
    }
}

function clearFileInfo() {
    parsedFirmware = null;
    dom.fileName.textContent = '-';
    dom.fileHash.textContent = '-';
    dom.fileSize.textContent = '-';
}

function onFileChange(event) {
    const file = event.target.files[0];
    if (!file) {
        clearFileInfo();
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
            clearFileInfo();
            // Flash is disabled internally via missing firmware, but Recover stays
            // available when a recover-capable target is selected.
            setButtonsEnabled(true);
        }
    };
    reader.onerror = () => {
        log(`Failed to read file: ${file.name}`, 'error');
        clearFileInfo();
        setButtonsEnabled(true);
    };
    reader.readAsText(file);
}

// Toggle the "probe identification checks disabled" warning box shown above
// the Steps preview. The warning is only relevant when the skip-probe-check
// checkbox is enabled; otherwise it stays hidden.
function updateUnknownProbeWarning() {
    if (!dom.unknownProbeWarning || !dom.skipProbeCheckCheckbox) return;
    const enabled = dom.skipProbeCheckCheckbox.checked;
    dom.unknownProbeWarning.classList.toggle('hidden', !enabled);
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

    // Restore + persist UI settings declaratively
    bindPersistedSettings([
        { element: dom.verifyCheckbox, key: 'freeocd_verify', kind: 'checkbox', onChange: updateStepPreview },
        { element: dom.skipProbeCheckCheckbox, key: 'freeocd_skip_probe_check', kind: 'checkbox', onChange: updateUnknownProbeWarning },
        { element: dom.autoScrollCheckbox, key: 'freeocd_autoscroll', kind: 'checkbox' },
        { element: dom.connectionMethod, key: 'freeocd_connection_method', kind: 'value' },
        { element: dom.rttScanStart, key: 'freeocd_rtt_scan_start', kind: 'value' },
        { element: dom.rttScanRange, key: 'freeocd_rtt_scan_range', kind: 'value' },
        { element: dom.rttPollingInterval, key: 'freeocd_rtt_polling_interval', kind: 'value' },
        { element: dom.memReadAddress, key: 'freeocd_mem_read_addr', kind: 'value' },
        { element: dom.memReadLength, key: 'freeocd_mem_read_len', kind: 'value' },
        { element: dom.memWriteAddress, key: 'freeocd_mem_write_addr', kind: 'value' },
        { element: dom.swjPinOutput, key: 'freeocd_swj_pin_out', kind: 'value' },
        { element: dom.swjPinSelect, key: 'freeocd_swj_pin_sel', kind: 'value' },
        { element: dom.swjPinWait, key: 'freeocd_swj_pin_wait', kind: 'value' },
        { element: dom.swjClock, key: 'freeocd_swj_clock', kind: 'value' }
    ]);
    updateUnknownProbeWarning();

    bindCollapsible(dom.rttSettingsToggle, dom.rttSettingsContent, 'freeocd_rtt_settings_collapsed');
    bindCollapsible(dom.advancedDebugToggle, dom.advancedDebugContent, 'freeocd_advanced_debug_collapsed');

    // Bind events
    dom.btnAgree.addEventListener('click', onDisclaimerAccept);
    dom.targetSelect.addEventListener('change', onTargetChange);
    dom.hexFile.addEventListener('change', onFileChange);
    dom.btnFlash.addEventListener('click', flashController.runFlash);
    dom.btnRecover.addEventListener('click', flashController.runRecover);

    // Utility button events
    dom.btnSoftReset.addEventListener('click', rttController.performSoftReset);
    dom.btnHardReset.addEventListener('click', rttController.performHardReset);
    dom.btnReadDeviceId.addEventListener('click', rttController.readDeviceInfo);
    dom.btnHalt.addEventListener('click', rttController.performHalt);
    dom.btnResume.addEventListener('click', rttController.performResume);
    dom.btnGetCoreState.addEventListener('click', rttController.getCoreState);
    dom.btnReadMemory.addEventListener('click', rttController.readMemory);
    dom.btnWriteMemory.addEventListener('click', rttController.writeMemory);
    dom.btnControlSwjPins.addEventListener('click', rttController.controlSwjPins);
    dom.btnSetSwjClock.addEventListener('click', rttController.setSwjClock);

    // Prevent page navigation when device is connected or operation is in progress
    window.addEventListener('beforeunload', (e) => {
        if (stateManager.getState().isRttConnected || operationLock.isAnyLocked()) {
            e.preventDefault();
            e.returnValue = '';
            return '';
        }
    });

    // React to physical USB unplug immediately instead of waiting for polling
    if (navigator.usb) {
        navigator.usb.addEventListener('disconnect', (event) => {
            rttController.handleUsbDisconnect(event.device);
        });
    }

    // RTT events
    dom.rttConnectBtn.addEventListener('click', async () => {
        if (stateManager.getState().isRttConnected) {
            await rttController.disconnectRtt();
        } else {
            await rttController.connectRtt();
        }
    });

    // Initialize utility buttons as disabled
    updateUtilityButtons();

    // Initialize terminal (even when disconnected)
    rttController.initTerminal();

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
        const lastTargetId = storage.get('freeocd_last_target');
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
        log(`Failed to load targets: ${error.message}`, 'error');
        dom.targetSelect.innerHTML = '<option value="">Failed to load targets</option>';
    }
}

init();
