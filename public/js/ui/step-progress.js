// Step preview and step progress UI.
// Renders the pre-execution step preview and the live per-step progress list
// (progress bar, elapsed/remaining time) shown during Flash/Recover.

import { STEP_RESET_DELAY_MS } from '../core/constants.js';

let dom = null;
let onActiveStep = () => {};

let currentSteps = [];
let currentStepIndex = -1;
let operationStartTime = null;
let stepStartTimes = [];
let stepResetTimerId = null;

/**
 * Initialize the step progress UI
 * @param {object} config - Configuration
 * @param {object} config.elements - DOM elements: stepPreview, stepPreviewList,
 *   stepProgress, stepList
 * @param {function} [config.onStepUpdate] - Called with (stepName, percent)
 *   whenever the active step or its progress changes (used for the status bar)
 */
export function initStepProgressUI({ elements, onStepUpdate }) {
    dom = elements;
    if (onStepUpdate) {
        onActiveStep = onStepUpdate;
    }
}

function formatTime(seconds) {
    if (seconds < 60) return `${Math.round(seconds)}s`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
    return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

/**
 * Render the pre-execution step preview list
 * @param {Array<string>} steps - Step names (or a single hint message)
 */
export function renderStepPreview(steps) {
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

/**
 * Whether the live step progress panel is currently visible
 * @returns {boolean}
 */
export function isStepProgressVisible() {
    return dom.stepProgress.classList.contains('visible');
}

/**
 * Initialize the live step progress list for a new operation.
 * Cancels any pending auto-reset from a previous operation.
 * @param {Array<string>} steps - Step names
 */
export function initStepProgress(steps) {
    cancelScheduledStepReset();

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

/**
 * Mark a step as active (and complete the previous one)
 * @param {number} index - Step index
 */
export function activateStep(index) {
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
        onActiveStep(currentSteps[index], 0);
    }
}

/**
 * Update the progress bar and text of a step
 * @param {number} index - Step index
 * @param {number} percent - Progress (0-100)
 * @param {string} [text] - Optional text overriding the default percentage
 */
export function updateStepProgress(index, percent, text) {
    const fill = document.getElementById(`step-fill-${index}`);
    const textEl = document.getElementById(`step-text-${index}`);
    if (fill) fill.style.width = `${percent}%`;

    let displayText = text || `${Math.round(percent)}%`;

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

    if (index === currentStepIndex && index < currentSteps.length) {
        onActiveStep(currentSteps[index], percent);
    }
}

/**
 * Mark a step as completed
 * @param {number} index - Step index
 */
export function completeStep(index) {
    const el = document.getElementById(`step-${index}`);
    if (el) {
        el.classList.remove('active');
        el.classList.add('completed');
        const indicator = el.querySelector('.step-indicator');
        if (indicator) indicator.textContent = '✓';
    }
}

/**
 * Mark a step as failed
 * @param {number} index - Step index
 */
export function failStep(index) {
    const el = document.getElementById(`step-${index}`);
    if (el) {
        el.classList.remove('active');
        el.classList.add('error');
        const indicator = el.querySelector('.step-indicator');
        if (indicator) indicator.textContent = '✗';
    }
}

/** Hide the live progress list and restore the step preview */
export function resetStepProgress() {
    stepResetTimerId = null;

    dom.stepProgress.classList.remove('visible');
    dom.stepPreview.style.display = '';
    currentSteps = [];
    currentStepIndex = -1;
    operationStartTime = null;
    stepStartTimes = [];
}

/** Schedule an automatic reset of the step progress panel */
export function scheduleStepReset() {
    stepResetTimerId = setTimeout(resetStepProgress, STEP_RESET_DELAY_MS);
}

/** Cancel a pending scheduled reset, if any */
export function cancelScheduledStepReset() {
    if (stepResetTimerId !== null) {
        clearTimeout(stepResetTimerId);
        stepResetTimerId = null;
    }
}
