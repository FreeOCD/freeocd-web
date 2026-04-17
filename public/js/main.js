// FreeOCD WebDebugger - Main application logic

import { TargetManager } from './platform/target-manager.js';
import { WebUSBTransport } from './transport/webusb-transport.js';
import { parseIntelHex } from './core/hex-parser.js';
import { sleep } from './core/dap-operations.js';
import { RTTHandler } from './core/rtt-handler.js';
import { Terminal } from './core/terminal.js';

// =============================================================================
// State
// =============================================================================

const targetManager = new TargetManager();
let transport = null;
let isOperationInProgress = false;
let parsedFirmware = null;

// RTT state
let rttProcessor = null;
let rttHandler = null;
let terminal = null;
let isRttConnected = false;
let isRttPolling = false;
let rttPollingInterval = 1; // ms
let rttAbortController = null;
let isReconnecting = false;

// Step definitions for each operation mode
const FLASH_STEPS_VERIFY = ['Connect', 'Mass Erase', 'Flash', 'Verify', 'Reset'];
const FLASH_STEPS_NO_VERIFY = ['Connect', 'Mass Erase', 'Flash', 'Reset'];
const RECOVER_STEPS = ['Connect', 'Mass Erase', 'Reset'];

// =============================================================================
// DOM References
// =============================================================================

const dom = {
    disclaimerModal: document.getElementById('disclaimerModal'),
    mainContent: document.getElementById('mainContent'),
    btnAgree: document.getElementById('btnAgree'),
    targetSelect: document.getElementById('targetSelect'),
    hexFile: document.getElementById('hexFile'),
    verifyCheckbox: document.getElementById('verifyCheckbox'),
    autoScrollCheckbox: null,
    btnFlash: document.getElementById('btnFlash'),
    btnRecover: document.getElementById('btnRecover'),
    statusIndicator: document.getElementById('statusIndicator'),
    deviceStatus: document.getElementById('deviceStatus'),
    operationStatus: document.getElementById('operationStatus'),
    stepPreview: document.getElementById('stepPreview'),
    stepPreviewList: document.getElementById('stepPreviewList'),
    stepProgress: document.getElementById('stepProgress'),
    stepList: document.getElementById('stepList'),
    logEl: document.getElementById('log'),
    logContainer: document.querySelector('.log-container'),
    fileInfo: document.getElementById('fileInfo'),
    fileHash: document.getElementById('fileHash'),
    fileSize: document.getElementById('fileSize'),
    // RTT elements
    rttPanel: document.getElementById('rttPanel'),
    rttConnectBtn: document.getElementById('rttConnectBtn'),
    rttScanStart: document.getElementById('rttScanStart'),
    rttScanRange: document.getElementById('rttScanRange'),
    rttPollingInterval: document.getElementById('rttPollingInterval'),
    rttTerminalContainer: document.getElementById('rttTerminalContainer')
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
// Status
// =============================================================================

function updateStatus(status, connected = false, busy = false) {
    dom.statusIndicator.className = 'status-indicator';
    if (busy) {
        dom.statusIndicator.classList.add('status-busy');
    } else if (connected) {
        dom.statusIndicator.classList.add('status-connected');
    } else {
        dom.statusIndicator.classList.add('status-disconnected');
    }
    dom.deviceStatus.textContent = status;
    
    // Update operation status
    if (busy) {
        dom.operationStatus.textContent = 'Operation in progress...';
    } else if (connected) {
        dom.operationStatus.textContent = 'Ready';
    } else {
        dom.operationStatus.textContent = 'Ready';
    }
}

function setButtonsEnabled(enabled) {
    dom.btnFlash.disabled = !enabled;
    dom.btnRecover.disabled = !enabled;
}

// =============================================================================
// Step Preview (before execution)
// =============================================================================

function updateStepPreview() {
    const capabilities = targetManager.getCapabilities();
    const hasRecover = capabilities.includes('recover');
    const hasFile = parsedFirmware !== null;
    const verify = dom.verifyCheckbox.checked;

    // Show/hide recover button
    if (hasRecover) {
        dom.btnRecover.classList.remove('hidden');
    } else {
        dom.btnRecover.classList.add('hidden');
    }

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

function initStepProgress(steps) {
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
    dom.stepProgress.classList.remove('visible');
    dom.stepPreview.style.display = '';
    currentSteps = [];
    currentStepIndex = -1;
}

// =============================================================================
// RTT Operations
// =============================================================================

async function connectRtt() {
    if (isRttConnected) {
        return;
    }

    try {
        log('=== RTT Connection ===', 'info');
        updateStatus('Selecting device for RTT...', false, true);

        transport = new WebUSBTransport();
        await transport.selectDevice(targetManager.getUsbFilters());

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

        // Initialize terminal
        if (!terminal) {
            terminal = new Terminal(dom.rttTerminalContainer, {
                onSend: (data) => sendToRtt(data),
                onClear: () => log('Terminal cleared', 'info'),
                onSave: (text) => saveRttLog(text)
            });
            terminal.init();
        }

        terminal.enable();
        terminal.focus();

        // Start polling
        startRttPolling();

        isRttConnected = true;
        dom.rttConnectBtn.textContent = 'Disconnect RTT';
        updateStatus(`RTT Connected: ${deviceName}`, true, false);

        // Disable Flash/Recover buttons
        dom.btnFlash.disabled = true;
        dom.btnRecover.disabled = true;

        log('=== RTT Connected Successfully ===', 'success');

    } catch (error) {
        log(`RTT connection error: ${error.message}`, 'error');
        updateStatus('RTT connection failed', false, false);
        await cleanupRtt();
    }
}

async function disconnectRtt() {
    if (!isRttConnected) {
        return;
    }

    log('Disconnecting RTT...', 'info');

    // Stop polling
    stopRttPolling();

    // Abort any reconnection in progress
    if (isReconnecting && rttAbortController) {
        rttAbortController.abort();
        isReconnecting = false;
        log('Reconnection aborted', 'info');
    }

    await cleanupRtt();

    isRttConnected = false;
    dom.rttConnectBtn.textContent = 'Connect RTT';
    updateStatus('RTT Disconnected', false, false);

    // Re-enable Flash/Recover buttons
    if (parsedFirmware) {
        dom.btnFlash.disabled = false;
    }
    dom.btnRecover.disabled = false;

    log('RTT disconnected', 'success');
}

async function cleanupRtt() {
    stopRttPolling();

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

    if (terminal) {
        terminal.disable();
    }
}

function startRttPolling() {
    if (isRttPolling) {
        return;
    }

    isRttPolling = true;
    rttAbortController = new AbortController();

    async function pollLoop() {
        while (isRttPolling && !rttAbortController.signal.aborted) {
            try {
                if (rttHandler && isRttConnected) {
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
                if (!rttAbortController.signal.aborted) {
                    log(`RTT polling error: ${error.message}`, 'warning');
                }
            }

            await sleep(rttPollingInterval);
        }
    }

    pollLoop();
}

function stopRttPolling() {
    isRttPolling = false;
    if (rttAbortController) {
        rttAbortController.abort();
        rttAbortController = null;
    }
}

async function sendToRtt(data) {
    if (!rttHandler || !isRttConnected) {
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

async function reconnectRtt() {
    if (isReconnecting || isRttConnected) {
        return;
    }

    isReconnecting = true;
    rttAbortController = new AbortController();

    log('Attempting to reconnect RTT...', 'info');

    try {
        // Wait a bit for device to stabilize
        await sleep(1000);

        // Check if aborted
        if (rttAbortController.signal.aborted) {
            log('Reconnection aborted by user', 'info');
            return;
        }

        await connectRtt();

    } catch (error) {
        log(`RTT reconnection failed: ${error.message}`, 'error');
    } finally {
        isReconnecting = false;
        rttAbortController = null;
    }
}

// =============================================================================
// Operations
// =============================================================================

async function runFlash() {
    if (isOperationInProgress) return;
    if (!parsedFirmware) {
        log('Please select a firmware file first', 'warning');
        return;
    }

    // Disconnect RTT if connected
    const wasRttConnected = isRttConnected;
    if (isRttConnected) {
        log('RTT is connected, disconnecting for flash operation...', 'info');
        await disconnectRtt();
    }

    clearLog();
    isOperationInProgress = true;
    setButtonsEnabled(false);

    const verify = dom.verifyCheckbox.checked;
    const steps = verify ? [...FLASH_STEPS_VERIFY] : [...FLASH_STEPS_NO_VERIFY];
    initStepProgress(steps);

    let dap = null;
    let stepIdx = 0;

    try {
        // Step: Connect
        activateStep(stepIdx);
        log('=== Flash Operation ===', 'info');
        log(`Firmware: ${parsedFirmware.size} bytes at 0x${parsedFirmware.startAddress.toString(16)}`, 'info');

        updateStatus('Selecting device...', false, true);
        transport = new WebUSBTransport();
        await transport.selectDevice(targetManager.getUsbFilters());

        const deviceName = transport.getDeviceName();
        log(`Device selected: ${deviceName}`, 'success');
        updateStatus(`Connected: ${deviceName}`, true, true);

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

        // Attempt to reconnect RTT if it was connected before
        if (wasRttConnected) {
            log('Attempting to reconnect RTT after flash...', 'info');
            await reconnectRtt();
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
        setTimeout(resetStepProgress, 3000);
    }
}

async function runRecover() {
    if (isOperationInProgress) return;

    // Disconnect RTT if connected
    const wasRttConnected = isRttConnected;
    if (isRttConnected) {
        log('RTT is connected, disconnecting for recover operation...', 'info');
        await disconnectRtt();
    }

    clearLog();
    isOperationInProgress = true;
    setButtonsEnabled(false);

    const steps = [...RECOVER_STEPS];
    initStepProgress(steps);

    let dap = null;
    let stepIdx = 0;

    try {
        // Step: Connect
        activateStep(stepIdx);
        log('=== Recover (Mass Erase) Operation ===', 'info');

        updateStatus('Selecting device...', false, true);
        transport = new WebUSBTransport();
        await transport.selectDevice(targetManager.getUsbFilters());

        const deviceName = transport.getDeviceName();
        log(`Device selected: ${deviceName}`, 'success');
        updateStatus(`Connected: ${deviceName}`, true, true);

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

        // Attempt to reconnect RTT if it was connected before
        if (wasRttConnected) {
            log('Attempting to reconnect RTT after recover...', 'info');
            await reconnectRtt();
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
        setTimeout(resetStepProgress, 3000);
    }
}

// =============================================================================
// Event Handlers
// =============================================================================

function onDisclaimerAccept() {
    dom.disclaimerModal.classList.add('hidden');
    dom.mainContent.classList.remove('disabled');
}

async function onTargetChange() {
    const targetId = dom.targetSelect.value;
    if (!targetId) {
        dom.btnFlash.disabled = true;
        dom.btnRecover.disabled = true;
        dom.btnRecover.classList.add('hidden');
        renderStepPreview(['Select a target to see steps']);
        return;
    }

    try {
        await targetManager.loadTarget(targetId);
        log(`Target loaded: ${targetManager.currentTarget.name}`, 'info');
        updateStepPreview();
        dom.btnFlash.disabled = !parsedFirmware;
        dom.btnRecover.disabled = false;
    } catch (error) {
        log(`Failed to load target: ${error.message}`, 'error');
    }
}

function onFileChange(event) {
    const file = event.target.files[0];
    if (!file) {
        parsedFirmware = null;
        dom.fileInfo.style.display = 'none';
        updateStepPreview();
        dom.btnFlash.disabled = true;
        return;
    }

    const reader = new FileReader();
    reader.onload = async (e) => {
        try {
            parsedFirmware = parseIntelHex(e.target.result);
            log(`HEX file loaded: ${parsedFirmware.size} bytes, start: 0x${parsedFirmware.startAddress.toString(16)}`, 'success');

            // Calculate hash and display file info
            const hash = await calculateSHA256(parsedFirmware.data);

            dom.fileHash.textContent = hash;
            dom.fileSize.textContent = `${formatFileSize(file.size)} (${formatFileSize(parsedFirmware.size)} actual)`;
            dom.fileInfo.style.display = 'block';

            updateStepPreview();
            if (dom.targetSelect.value) {
                dom.btnFlash.disabled = false;
            }
        } catch (error) {
            log(`HEX parse error: ${error.message}`, 'error');
            parsedFirmware = null;
            dom.fileInfo.style.display = 'none';
            dom.btnFlash.disabled = true;
        }
    };
    reader.readAsText(file);
}

function onVerifyChange() {
    updateStepPreview();
}

// =============================================================================
// Initialization
// =============================================================================

async function init() {
    // Initialize autoScrollCheckbox reference
    dom.autoScrollCheckbox = document.getElementById('autoScrollCheckbox');

    // Bind events
    dom.btnAgree.addEventListener('click', onDisclaimerAccept);
    dom.targetSelect.addEventListener('change', onTargetChange);
    dom.hexFile.addEventListener('change', onFileChange);
    dom.verifyCheckbox.addEventListener('change', onVerifyChange);
    dom.btnFlash.addEventListener('click', runFlash);
    dom.btnRecover.addEventListener('click', runRecover);

    // RTT events
    if (dom.rttConnectBtn) {
        dom.rttConnectBtn.addEventListener('click', async () => {
            if (isRttConnected) {
                await disconnectRtt();
            } else {
                await connectRtt();
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

    // Load target index
    try {
        const targets = await targetManager.loadTargetIndex();
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
    } catch (error) {
        log(`Failed to load targets: ${error.message}`, 'error');
        dom.targetSelect.innerHTML = '<option value="">Failed to load targets</option>';
    }

    renderStepPreview(['Select a target to see steps']);
}

init();
