// Declarative persistence for UI settings.
// Binds form controls and collapsible panels to localStorage keys so
// restore/save logic is a table, not twenty copies of the same listener.

import { storage } from '../core/storage.js';

/**
 * Bind form controls to localStorage keys.
 *
 * Each binding restores the stored value on call and saves on 'change'.
 * @param {Array<object>} bindings - Binding descriptors:
 *   - element {HTMLElement} - Input/select element
 *   - key {string} - localStorage key
 *   - kind {'checkbox'|'value'} - Which property to persist
 *   - onChange {function} [optional] - Extra handler run after saving
 *   - restoreOnly {boolean} [optional] - Restore without attaching a listener
 */
export function bindPersistedSettings(bindings) {
    for (const { element, key, kind, onChange, restoreOnly } of bindings) {
        if (!element) continue;

        const stored = storage.get(key);
        if (stored !== null) {
            if (kind === 'checkbox') {
                element.checked = stored === 'true';
            } else {
                element.value = stored;
            }
        }

        if (restoreOnly) continue;

        element.addEventListener('change', () => {
            storage.set(key, kind === 'checkbox' ? element.checked : element.value);
            if (onChange) onChange();
        });
    }
}

/**
 * Bind a collapsible panel (toggle header + content) to a localStorage key.
 * The collapsed state is restored on call and persisted on toggle.
 * @param {HTMLElement} toggleEl - Header element carrying the 'collapsed' class
 * @param {HTMLElement} contentEl - Content element carrying the 'collapsed' class
 * @param {string} key - localStorage key
 */
export function bindCollapsible(toggleEl, contentEl, key) {
    if (!toggleEl || !contentEl) return;

    if (storage.get(key) === 'false') {
        toggleEl.classList.remove('collapsed');
        contentEl.classList.remove('collapsed');
    }

    toggleEl.addEventListener('click', () => {
        const isCollapsed = toggleEl.classList.contains('collapsed');
        toggleEl.classList.toggle('collapsed');
        contentEl.classList.toggle('collapsed');
        storage.set(key, !isCollapsed);
    });
}
