import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = fileURLToPath(new URL('../public/', import.meta.url));

// Minimal fetch() that serves files from public/, like the static site does.
export async function publicFetch(url) {
    const rel = String(url).replace(/^\.?\//, '');
    try {
        const body = await readFile(PUBLIC_DIR + rel, 'utf8');
        return new Response(body, { status: 200 });
    } catch {
        return new Response('not found', { status: 404 });
    }
}

// Build one Intel HEX record with a correct checksum.
export function hexRecord(type, address, bytes = []) {
    const raw = [bytes.length, (address >> 8) & 0xFF, address & 0xFF, type, ...bytes];
    const checksum = (-raw.reduce((a, b) => a + b, 0)) & 0xFF;
    return ':' + [...raw, checksum].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
}
