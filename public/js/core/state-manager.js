// StateManager - Centralized state management for RTT and device connections
// Provides polling, event listeners, and automatic error handling

import { STATE_POLLING_INTERVAL_MS } from './constants.js';

/**
 * Centralized state management for RTT and device connections
 * Provides polling, event listeners, and automatic error handling
 */
export class StateManager {
    constructor() {
        // State
        this._isRttConnected = false;
        this._isDeviceConnected = false;
        this._rttProcessor = null;
        this._rttHandler = null;

        // Polling control
        this._isPolling = false;
        this._pollingInterval = STATE_POLLING_INTERVAL_MS;
        this._abortController = null;

        // External operation flag to prevent polling interference
        this._isExternalOperationInProgress = false;

        // Event listeners
        this._listeners = {
            stateChange: [],
            rttConnected: [],
            rttDisconnected: [],
            deviceConnected: [],
            deviceDisconnected: [],
            error: []
        };

        // Callbacks for external operations
        this._onLog = null;
        this._onUpdateStatus = null;
        this._onCleanup = null;
    }

    /**
     * Set callbacks for state changes and error handling
     * @param {object} callbacks - Callback functions
     * @param {function} callbacks.onLog - Logging callback (message: string, type: string)
     * @param {function} callbacks.onUpdateStatus - Status update callback
     * @param {function} callbacks.onCleanup - Cleanup callback on error
     */
    setCallbacks({ onLog, onUpdateStatus, onCleanup }) {
        this._onLog = onLog;
        this._onUpdateStatus = onUpdateStatus;
        this._onCleanup = onCleanup;
    }
    
    // Set external operation flag to prevent polling interference
    setExternalOperationInProgress(inProgress) {
        this._isExternalOperationInProgress = inProgress;
    }
    
    // Set RTT processor and handler
    setRttComponents(processor, handler) {
        this._rttProcessor = processor;
        this._rttHandler = handler;
    }
    
    // Get current state
    getState() {
        return {
            isRttConnected: this._isRttConnected,
            isDeviceConnected: this._isDeviceConnected
        };
    }
    
    // Manually set RTT connected state (for initial connection)
    setRttConnected(connected) {
        const oldState = this._isRttConnected;
        this._isRttConnected = connected;
        
        if (connected && !oldState) {
            this._emit('rttConnected');
        } else if (!connected && oldState) {
            this._emit('rttDisconnected');
        }
        
        this._emit('stateChange', this.getState());
    }
    
    // Manually set device connected state
    setDeviceConnected(connected) {
        const oldState = this._isDeviceConnected;
        this._isDeviceConnected = connected;
        
        if (connected && !oldState) {
            this._emit('deviceConnected');
        } else if (!connected && oldState) {
            this._emit('deviceDisconnected');
        }
        
        this._emit('stateChange', this.getState());
    }
    
    // Start polling
    startPolling() {
        if (this._isPolling) {
            return;
        }
        
        this._isPolling = true;
        this._abortController = new AbortController();
        
        this._pollLoop();
    }
    
    // Stop polling
    stopPolling() {
        this._isPolling = false;
        if (this._abortController) {
            this._abortController.abort();
            this._abortController = null;
        }
    }
    
    // Polling loop. The abort signal is captured locally because
    // stopPolling() nulls this._abortController while the loop may still be
    // awaiting; a stale loop iteration must not dereference the cleared field.
    async _pollLoop() {
        const signal = this._abortController.signal;
        while (this._isPolling && !signal.aborted) {
            // Skip polling during external operations (Flash/Recover)
            if (this._isExternalOperationInProgress) {
                await new Promise(resolve => setTimeout(resolve, this._pollingInterval));
                continue;
            }
            
            try {
                await this._checkDeviceState();
                await this._checkRttState();
            } catch (error) {
                if (!signal.aborted) {
                    await this._handleError(error);
                }
            }
            
            // Wait for polling interval
            await new Promise(resolve => setTimeout(resolve, this._pollingInterval));
        }
    }
    
    // Check device state using DAPjs
    async _checkDeviceState() {
        if (!this._rttProcessor) {
            if (this._isDeviceConnected) {
                this.setDeviceConnected(false);
            }
            return;
        }
        
        try {
            // Try to get core state to verify connection
            await this._rttProcessor.getState();
            
            if (!this._isDeviceConnected) {
                this.setDeviceConnected(true);
            }
        } catch (error) {
            // Device is not accessible
            if (this._isDeviceConnected) {
                await this._handleError(new Error(`Device connection lost: ${error.message}`));
                this.setDeviceConnected(false);
            }
        }
    }
    
    // Check RTT state
    async _checkRttState() {
        if (!this._rttHandler) {
            if (this._isRttConnected) {
                this.setRttConnected(false);
            }
            return;
        }
        
        // RTT state is primarily managed by the polling in main.js
        // This is a sanity check
        if (!this._rttProcessor && this._isRttConnected) {
            this.setRttConnected(false);
        }
    }
    
    // Handle errors. Cleanup is awaited so that the polling loop does not
    // race ahead (and poll a dead connection again) while teardown is still
    // in flight.
    async _handleError(error) {
        this._emit('error', error);

        if (this._onLog) {
            this._onLog(`State monitoring error: ${error.message}`, 'error');
        }

        // If RTT was connected, trigger cleanup
        if (this._isRttConnected && this._onCleanup) {
            try {
                await this._onCleanup();
            } catch (cleanupError) {
                console.error('Cleanup after state error failed:', cleanupError);
            }
        }
    }
    
    // Event listener registration
    on(event, callback) {
        if (this._listeners[event]) {
            this._listeners[event].push(callback);
        }
    }
    
    // Remove event listener
    off(event, callback) {
        if (this._listeners[event]) {
            const index = this._listeners[event].indexOf(callback);
            if (index > -1) {
                this._listeners[event].splice(index, 1);
            }
        }
    }
    
    // Emit event
    _emit(event, data) {
        if (this._listeners[event]) {
            this._listeners[event].forEach(callback => {
                try {
                    callback(data);
                } catch (error) {
                    console.error(`Error in event listener for ${event}:`, error);
                }
            });
        }
    }
    
    // Cleanup
    destroy() {
        this.stopPolling();
        this._listeners = {
            stateChange: [],
            rttConnected: [],
            rttDisconnected: [],
            deviceConnected: [],
            deviceDisconnected: [],
            error: []
        };
        this._rttProcessor = null;
        this._rttHandler = null;
        this._onLog = null;
        this._onUpdateStatus = null;
        this._onCleanup = null;
    }
}
