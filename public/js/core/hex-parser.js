// Intel HEX file parser
// Parses Intel HEX format files into contiguous binary data with address info.
// Records are validated strictly (hex characters, length, checksum) so a
// malformed file is rejected instead of producing corrupt firmware data.

// Upper bound for the contiguous image span (maxAddress - minAddress). A HEX
// file with widely separated segments would otherwise allocate a huge buffer.
const MAX_IMAGE_SPAN = 32 * 1024 * 1024; // 32 MB

const HEX_BODY_PATTERN = /^[0-9A-Fa-f]+$/;

/**
 * Parse Intel HEX format string into binary data
 * @param {string} hexString - Intel HEX format string
 * @returns {object} Parsed firmware data with:
 *   - data: Uint8Array of binary data (gaps filled with 0xFF)
 *   - startAddress: Starting address of the data
 *   - size: Size of the data in bytes
 * @throws {Error} If a record is malformed, a checksum fails, the image span
 *   exceeds MAX_IMAGE_SPAN, or no data is found
 */
export function parseIntelHex(hexString) {
    const lines = hexString.split(/\r?\n/);
    const segments = []; // { address, data: Uint8Array }
    let extendedAddress = 0;
    let minAddress = Infinity;
    let maxAddress = 0;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex].trim();
        if (!line.startsWith(':')) continue;

        const lineNumber = lineIndex + 1;
        const body = line.slice(1);

        if (body.length % 2 !== 0 || !HEX_BODY_PATTERN.test(body)) {
            throw new Error(`Invalid hex characters in HEX file at line ${lineNumber}`);
        }

        const bytes = new Uint8Array(body.length / 2);
        for (let i = 0; i < bytes.length; i++) {
            bytes[i] = parseInt(body.substr(i * 2, 2), 16);
        }

        if (bytes.length < 5) {
            throw new Error(`Record too short in HEX file at line ${lineNumber}`);
        }

        const byteCount = bytes[0];
        const address = (bytes[1] << 8) | bytes[2];
        const recordType = bytes[3];

        if (bytes.length !== byteCount + 5) {
            throw new Error(
                `Record length mismatch in HEX file at line ${lineNumber}: ` +
                `byte count is ${byteCount} but record has ${bytes.length - 5} data bytes`
            );
        }

        const recordData = bytes.subarray(4, 4 + byteCount);

        // Verify checksum
        let checksum = 0;
        for (let i = 0; i < bytes.length - 1; i++) {
            checksum += bytes[i];
        }
        checksum = (~checksum + 1) & 0xFF;

        if (checksum !== bytes[bytes.length - 1]) {
            throw new Error(`Checksum error in HEX file at line ${lineNumber}`);
        }

        switch (recordType) {
            case 0x00: { // Data record
                if (byteCount > 0) {
                    const fullAddress = extendedAddress + address;
                    segments.push({ address: fullAddress, data: recordData });
                    minAddress = Math.min(minAddress, fullAddress);
                    maxAddress = Math.max(maxAddress, fullAddress + byteCount);
                }
                break;
            }
            case 0x01: // End of file
                break;

            case 0x02: // Extended segment address
                if (byteCount !== 2) {
                    throw new Error(`Invalid extended segment address record at line ${lineNumber}`);
                }
                extendedAddress = ((recordData[0] << 8) | recordData[1]) << 4;
                break;

            case 0x04: // Extended linear address
                if (byteCount !== 2) {
                    throw new Error(`Invalid extended linear address record at line ${lineNumber}`);
                }
                extendedAddress = ((recordData[0] << 8) | recordData[1]) << 16;
                break;

            case 0x03: // Start segment address
            case 0x05: // Start linear address
                // Ignore start address records
                break;

            default:
                console.warn(`Unknown record type: ${recordType}`);
        }
    }

    if (segments.length === 0) {
        throw new Error('No data found in HEX file');
    }

    const size = maxAddress - minAddress;
    if (size > MAX_IMAGE_SPAN) {
        throw new Error(
            `HEX file spans ${size} bytes (0x${minAddress.toString(16)}-0x${maxAddress.toString(16)}), ` +
            `exceeding the ${MAX_IMAGE_SPAN}-byte limit`
        );
    }

    // Convert to contiguous buffer
    const buffer = new Uint8Array(size);
    buffer.fill(0xFF); // Fill with 0xFF (erased flash value)

    for (const segment of segments) {
        buffer.set(segment.data, segment.address - minAddress);
    }

    return {
        data: buffer,
        startAddress: minAddress,
        size: size
    };
}
