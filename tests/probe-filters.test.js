import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadProbeFilters } from '../public/js/core/probe-filters.js';
import { publicFetch } from './helpers.js';

function stubFetch(impl) {
    vi.stubGlobal('fetch', vi.fn(impl));
}

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('loadProbeFilters', () => {
    it('loads the shipped public/targets/probe-filters.json', async () => {
        stubFetch(publicFetch);
        const filters = await loadProbeFilters('targets');
        expect(filters.length).toBeGreaterThan(0);
        for (const filter of filters) {
            expect(Number.isInteger(filter.vendorId)).toBe(true);
            expect(filter.vendorId).toBeGreaterThan(0);
            expect(filter.vendorId).toBeLessThanOrEqual(0xFFFF);
        }
    });

    it('accepts both string and object entries and skips invalid ones', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubFetch(async () => Response.json({
            vendorIds: ['0x0D28', { vid: '0x1366', $comment: 'SEGGER' }, 42, { vid: 'zz' }, null],
        }));
        expect(await loadProbeFilters()).toEqual([{ vendorId: 0x0D28 }, { vendorId: 0x1366 }]);
        expect(console.warn).toHaveBeenCalledTimes(3);
    });

    it.each([
        ['network error', async () => { throw new Error('offline'); }],
        ['HTTP error', async () => new Response('', { status: 404 })],
        ['invalid JSON', async () => new Response('{', { status: 200 })],
        ['missing vendorIds', async () => Response.json({})],
    ])('falls back to no filter on %s', async (_name, impl) => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        stubFetch(impl);
        expect(await loadProbeFilters()).toEqual([]);
        expect(console.warn).toHaveBeenCalledOnce();
    });
});
