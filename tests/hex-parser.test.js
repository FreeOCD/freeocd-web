import { describe, expect, it } from 'vitest';
import { parseIntelHex } from '../public/js/core/hex-parser.js';
import { hexRecord } from './helpers.js';

const EOF_RECORD = ':00000001FF';

describe('parseIntelHex', () => {
    it('parses data records into a contiguous image', () => {
        const hex = [hexRecord(0, 0x0000, [1, 2, 3, 4]), hexRecord(0, 0x0004, [5, 6]), EOF_RECORD].join('\n');
        const result = parseIntelHex(hex);
        expect(result.startAddress).toBe(0);
        expect(result.size).toBe(6);
        expect([...result.data]).toEqual([1, 2, 3, 4, 5, 6]);
    });

    it('fills gaps with 0xFF and accepts CRLF line endings', () => {
        const hex = [hexRecord(0, 0x0010, [0xAA]), hexRecord(0, 0x0013, [0xBB]), EOF_RECORD].join('\r\n');
        const result = parseIntelHex(hex);
        expect(result.startAddress).toBe(0x10);
        expect([...result.data]).toEqual([0xAA, 0xFF, 0xFF, 0xBB]);
    });

    it('applies extended linear and segment addresses', () => {
        const linear = parseIntelHex([hexRecord(4, 0, [0x00, 0x01]), hexRecord(0, 0x0100, [7]), EOF_RECORD].join('\n'));
        expect(linear.startAddress).toBe(0x00010100);
        const segment = parseIntelHex([hexRecord(2, 0, [0x10, 0x00]), hexRecord(0, 0x0002, [8]), EOF_RECORD].join('\n'));
        expect(segment.startAddress).toBe(0x00010002);
    });

    it('ignores start address records and non-record lines', () => {
        const hex = ['# comment', hexRecord(5, 0, [0, 0, 0x01, 0x00]), hexRecord(0, 0, [9]), EOF_RECORD].join('\n');
        expect([...parseIntelHex(hex).data]).toEqual([9]);
    });

    it('rejects a bad checksum with the line number', () => {
        const good = hexRecord(0, 0, [1, 2]);
        const bad = good.slice(0, -2) + '00';
        expect(() => parseIntelHex(`${EOF_RECORD}\n${bad}`)).toThrow(/Checksum error.*line 2/);
    });

    it('rejects invalid characters, short records and length mismatches', () => {
        expect(() => parseIntelHex(':0G000000')).toThrow(/Invalid hex characters/);
        expect(() => parseIntelHex(':00000001')).toThrow(/Record too short/);
        expect(() => parseIntelHex(':0400000001FB')).toThrow(/Record length mismatch/);
    });

    it('rejects malformed extended address records', () => {
        expect(() => parseIntelHex(hexRecord(4, 0, [1]))).toThrow(/extended linear address/);
        expect(() => parseIntelHex(hexRecord(2, 0, [1, 2, 3]))).toThrow(/extended segment address/);
    });

    it('rejects files without data', () => {
        expect(() => parseIntelHex(EOF_RECORD)).toThrow(/No data found/);
        expect(() => parseIntelHex('')).toThrow(/No data found/);
    });

    it('rejects images spanning more than 32 MB', () => {
        const hex = [
            hexRecord(0, 0, [1]),
            hexRecord(4, 0, [0x02, 0x01]),
            hexRecord(0, 0, [2]),
        ].join('\n');
        expect(() => parseIntelHex(hex)).toThrow(/exceeding the 33554432-byte limit/);
    });
});
