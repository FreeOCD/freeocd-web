// Intel HEX file parser
// Parses Intel HEX format files into contiguous binary data with address info.

/**
 * Parse Intel HEX format string into binary data
 * @param {string} hexString - Intel HEX format string
 * @returns {object} Parsed firmware data with:
 *   - data: Uint8Array of binary data
 *   - startAddress: Starting address of the data
 *   - size: Size of the data in bytes
 * @throws {Error} If checksum validation fails or no data found
 */
export function parseIntelHex(hexString) {
    const lines = hexString.split(/\r?\n/);
    const data = [];
    let extendedAddress = 0;
    let minAddress = Infinity;
    let maxAddress = 0;

    for (const line of lines) {
        if (!line.startsWith(':')) continue;

        const bytes = [];
        for (let i = 1; i < line.length; i += 2) {
            bytes.push(parseInt(line.substr(i, 2), 16));
        }

        const byteCount = bytes[0];
        const address = (bytes[1] << 8) | bytes[2];
        const recordType = bytes[3];
        const recordData = bytes.slice(4, 4 + byteCount);

        // Verify checksum
        let checksum = 0;
        for (let i = 0; i < bytes.length - 1; i++) {
            checksum += bytes[i];
        }
        checksum = (~checksum + 1) & 0xFF;

        if (checksum !== bytes[bytes.length - 1]) {
            throw new Error(`Checksum error in HEX file at line: ${line}`);
        }

        switch (recordType) {
            case 0x00: { // Data record
                const fullAddress = extendedAddress + address;
                for (let i = 0; i < recordData.length; i++) {
                    data.push({ address: fullAddress + i, value: recordData[i] });
                }
                minAddress = Math.min(minAddress, fullAddress);
                maxAddress = Math.max(maxAddress, fullAddress + recordData.length);
                break;
            }
            case 0x01: // End of file
                break;

            case 0x02: // Extended segment address
                extendedAddress = ((recordData[0] << 8) | recordData[1]) << 4;
                break;

            case 0x04: // Extended linear address
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

    if (data.length === 0) {
        throw new Error('No data found in HEX file');
    }

    // Convert to contiguous buffer
    const size = maxAddress - minAddress;
    const buffer = new Uint8Array(size);
    buffer.fill(0xFF); // Fill with 0xFF (erased flash value)

    for (const { address, value } of data) {
        buffer[address - minAddress] = value;
    }

    return {
        data: buffer,
        startAddress: minAddress,
        size: size
    };
}
