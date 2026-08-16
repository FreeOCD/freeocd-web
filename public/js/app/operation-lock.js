// Operation lock - the single concurrency guard for the application.
// Exactly one of FLASH / RECOVER / RTT may run at a time; all subsystems
// (operation runners, RTT controller, UI button gating, beforeunload) consult
// this lock rather than keeping their own flags.

export class OperationLock {
    constructor() {
        this._currentLock = null; // null, 'FLASH', 'RECOVER', 'RTT'
        this._lockOwner = null; // Description of who holds the lock
    }

    /**
     * Try to acquire a lock
     * @param {string} operationType - 'FLASH', 'RECOVER', or 'RTT'
     * @param {string} owner - Description of who is acquiring the lock
     * @returns {boolean} True if acquired (or already held by the same type)
     */
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
        return false;
    }

    /**
     * Release the lock if held by the given operation type
     * @param {string} operationType - Operation type that acquired the lock
     */
    release(operationType) {
        if (this._currentLock === operationType) {
            this._currentLock = null;
            this._lockOwner = null;
        }
    }

    /**
     * Get the current lock type
     * @returns {string|null} 'FLASH', 'RECOVER', 'RTT', or null
     */
    getCurrentLock() {
        return this._currentLock;
    }

    /**
     * Check if any operation holds the lock
     * @returns {boolean}
     */
    isAnyLocked() {
        return this._currentLock !== null;
    }
}

// Shared application-wide lock instance
export const operationLock = new OperationLock();
