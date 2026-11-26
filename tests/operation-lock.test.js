import { describe, expect, it } from 'vitest';
import { OperationLock } from '../public/js/app/operation-lock.js';

describe('OperationLock', () => {
    it('allows exactly one operation type at a time', () => {
        const lock = new OperationLock();
        expect(lock.isAnyLocked()).toBe(false);
        expect(lock.tryAcquire('FLASH', 'flash button')).toBe(true);
        expect(lock.tryAcquire('RTT', 'rtt button')).toBe(false);
        expect(lock.getCurrentLock()).toBe('FLASH');
    });

    it('is re-entrant for the same operation type', () => {
        const lock = new OperationLock();
        expect(lock.tryAcquire('RTT', 'a')).toBe(true);
        expect(lock.tryAcquire('RTT', 'b')).toBe(true);
    });

    it('only releases when called by the holder', () => {
        const lock = new OperationLock();
        lock.tryAcquire('RECOVER', 'recover button');
        lock.release('FLASH');
        expect(lock.getCurrentLock()).toBe('RECOVER');
        lock.release('RECOVER');
        expect(lock.getCurrentLock()).toBeNull();
        expect(lock.tryAcquire('FLASH', 'flash button')).toBe(true);
    });
});
