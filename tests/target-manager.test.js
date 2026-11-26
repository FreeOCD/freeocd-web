import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { TargetManager } from '../public/js/platform/target-manager.js';
import { publicFetch } from './helpers.js';

const index = JSON.parse(await readFile(new URL('../public/targets/index.json', import.meta.url), 'utf8'));

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(publicFetch));
});

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('TargetManager with the shipped targets', () => {
    it('loads every target listed in index.json', async () => {
        const manager = new TargetManager();
        const { targets, failedIds } = await manager.loadTargetIndex('targets');
        expect(failedIds).toEqual([]);
        expect(targets.map((t) => t.id)).toEqual(index.targets);
        for (const target of targets) {
            expect(target.platform).toBeTypeOf('string');
            expect(target.capabilities.length).toBeGreaterThan(0);
        }
    });

    it.each(index.targets)('creates a platform handler for %s from the cache', async (id) => {
        const manager = new TargetManager();
        await manager.loadTargetIndex('targets');
        const calls = fetch.mock.calls.length;
        const def = await manager.loadTarget(id, 'targets');
        expect(fetch.mock.calls.length).toBe(calls);
        expect(def.id).toBe(id);
        expect(manager.createHandler(() => {})).toBeTruthy();
        expect(manager.hasCapability('flash')).toBe(true);
    });
});

describe('TargetManager error handling', () => {
    it('skips invalid, duplicate and missing targets', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        const real = index.targets[0];
        fetch.mockImplementation(async (url) => (url === 'targets/index.json'
            ? Response.json({ targets: [real, real, '', 7, 'nordic/none/missing'] })
            : publicFetch(url)));
        const { targets, failedIds } = await new TargetManager().loadTargetIndex('targets');
        expect(targets.map((t) => t.id)).toEqual([real]);
        expect(failedIds).toEqual(['nordic/none/missing']);
    });

    it('throws when the index cannot be loaded', async () => {
        await expect(new TargetManager().loadTargetIndex('nowhere')).rejects.toThrow(/404/);
    });

    it('rejects unknown platforms and missing targets', async () => {
        const manager = new TargetManager();
        expect(() => manager.createHandler(() => {})).toThrow(/No target loaded/);
        expect(manager.getCapabilities()).toEqual(['flash']);
        fetch.mockImplementation(async () => Response.json({ id: 'x', platform: 'unknown' }));
        await manager.loadTarget('x');
        expect(() => manager.createHandler(() => {})).toThrow(/No handler registered for platform: unknown/);
        fetch.mockImplementation(async () => new Response('', { status: 404 }));
        await expect(manager.loadTarget('y')).rejects.toThrow(/Failed to load target y: 404/);
    });
});
