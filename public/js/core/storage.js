// Safe localStorage wrapper.
// localStorage can throw (private browsing, disabled storage, quota); every
// access goes through this module so callers never need their own try/catch.

export const storage = {
    /**
     * Read a value from localStorage
     * @param {string} key - Storage key
     * @returns {string|null} Stored value, or null if missing/unavailable
     */
    get(key) {
        try {
            return localStorage.getItem(key);
        } catch (error) {
            console.warn(`Failed to read "${key}" from localStorage:`, error);
            return null;
        }
    },

    /**
     * Write a value to localStorage
     * @param {string} key - Storage key
     * @param {*} value - Value to store (stringified)
     */
    set(key, value) {
        try {
            localStorage.setItem(key, String(value));
        } catch (error) {
            console.warn(`Failed to save "${key}" to localStorage:`, error);
        }
    },

    /**
     * Remove a value from localStorage
     * @param {string} key - Storage key
     */
    remove(key) {
        try {
            localStorage.removeItem(key);
        } catch (error) {
            console.warn(`Failed to remove "${key}" from localStorage:`, error);
        }
    }
};
