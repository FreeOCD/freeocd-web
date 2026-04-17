// RTT (Real-Time Transfer) Handler
// Based on SEGGER RTT protocol implementation
//
// Portions of this file are derived from dapjs/examples/rtt/rtt.js
// (MIT License, Copyright (C) 2021 Ciro Cattuto)

export class RTTHandler {
    constructor(processor, options = {}) {
        this.processor = processor;
        this.scanStartAddress = options.scanStartAddress || 0x20000000;
        this.scanRange = options.scanRange || 0x10000; // 64KB
        this.scanBlockSize = options.scanBlockSize || 0x1000; // 4KB
        this.scanStride = options.scanStride || 0x0800; // 2KB
        this.rttSignature = "53454747455220525454"; // "SEGGER RTT"

        this.numBufUp = 0;
        this.numBufDown = 0;
        this.bufUp = {};
        this.bufDown = {};
        this.rttCtrlAddr = null;
        this.isInitialized = false;
    }

    async init() {
        // Locate RTT control block
        console.log("Locating RTT control block...");

        // Inspect windows with stride
        for (let offset = 0; offset < this.scanRange; offset += this.scanStride) {
            console.log(`Scanning at 0x${(this.scanStartAddress + offset).toString(16)}`);
            try {
                const data32 = await this.processor.readBlock(this.scanStartAddress + offset, this.scanBlockSize / 4);
                const data = new Uint8Array(data32.buffer);
                const sigIndex = this.toHexString(data).indexOf(this.rttSignature) / 2;
                if (sigIndex >= 0) {
                    this.rttCtrlAddr = this.scanStartAddress + offset + sigIndex;
                    console.log(`Found at 0x${this.rttCtrlAddr.toString(16)}`);
                    break;
                }
            } catch (error) {
                console.warn(`Scan error at offset 0x${offset.toString(16)}:`, error.message);
            }
        }

        if (!this.rttCtrlAddr) {
            console.log("RTT control block not found.");
            return -1;
        }

        // Load control block
        const data32 = await this.processor.readBlock(this.rttCtrlAddr, this.scanBlockSize / 4);
        const data = new Uint8Array(data32.buffer);
        const dv = new DataView(data.buffer);

        // Number of up- and down-buffers
        this.numBufUp = dv.getUint32(16, true);
        this.numBufDown = dv.getUint32(20, true);

        console.log(`RTT: ${this.numBufUp} up buffers, ${this.numBufDown} down buffers`);

        // Up-buffers (target to host)
        for (let bufIndex = 0; bufIndex < this.numBufUp; bufIndex++) {
            const bufOffset = 24 + bufIndex * 24;
            this.bufUp[bufIndex] = {};
            const rttBuf = this.bufUp[bufIndex];
            rttBuf.bufAddr = this.rttCtrlAddr + bufOffset;
            rttBuf.pBuffer = dv.getUint32(bufOffset + 4, true);
            rttBuf.SizeOfBuffer = dv.getUint32(bufOffset + 8, true);
            rttBuf.WrOff = dv.getUint32(bufOffset + 12, true);
            rttBuf.RdOff = dv.getUint32(bufOffset + 16, true);
            rttBuf.Flags = dv.getUint32(bufOffset + 20, true);
        }

        // Down-buffers (host to target)
        for (let bufIndex = 0; bufIndex < this.numBufDown; bufIndex++) {
            const bufOffset = 24 + (this.numBufUp + bufIndex) * 24;
            this.bufDown[bufIndex] = {};
            const rttBuf = this.bufDown[bufIndex];
            rttBuf.bufAddr = this.rttCtrlAddr + bufOffset;
            rttBuf.pBuffer = dv.getUint32(bufOffset + 4, true);
            rttBuf.SizeOfBuffer = dv.getUint32(bufOffset + 8, true);
            rttBuf.WrOff = dv.getUint32(bufOffset + 12, true);
            rttBuf.RdOff = dv.getUint32(bufOffset + 16, true);
            rttBuf.Flags = dv.getUint32(bufOffset + 20, true);
        }

        this.isInitialized = true;
        return this.numBufUp + this.numBufDown;
    }

    toHexString(byteArray) {
        return Array.from(byteArray, function(byte) {
            return ('0' + (byte & 0xFF).toString(16)).slice(-2);
        }).join('');
    }

    async read(bufId = 0) {
        if (!this.isInitialized) {
            throw new Error('RTT not initialized');
        }

        const buf = this.bufUp[bufId];
        if (!buf) {
            throw new Error(`Up buffer ${bufId} not found`);
        }

        buf.RdOff = await this.processor.readMem32(buf.bufAddr + 16);
        buf.WrOff = await this.processor.readMem32(buf.bufAddr + 12);

        if (buf.WrOff > buf.RdOff) {
            const data = await this.processor.readBytes(buf.pBuffer + buf.RdOff, buf.WrOff - buf.RdOff);
            buf.RdOff = buf.WrOff;
            await this.processor.writeMem32(buf.bufAddr + 16, buf.RdOff);
            return data;
        } else if (buf.WrOff < buf.RdOff) {
            const data1 = await this.processor.readBytes(buf.pBuffer + buf.RdOff, buf.SizeOfBuffer - buf.RdOff);
            const data2 = await this.processor.readBytes(buf.pBuffer, buf.WrOff);
            const data = new Uint8Array(data1.length + data2.length);
            data.set(data1, 0);
            data.set(data2, data1.length);
            buf.RdOff = buf.WrOff;
            await this.processor.writeMem32(buf.bufAddr + 16, buf.RdOff);
            return data;
        } else {
            return new Uint8Array(0);
        }
    }

    async write(bufId = 0, data) {
        if (!this.isInitialized) {
            throw new Error('RTT not initialized');
        }

        const buf = this.bufDown[bufId];
        if (!buf) {
            throw new Error(`Down buffer ${bufId} not found`);
        }

        buf.RdOff = await this.processor.readMem32(buf.bufAddr + 16);
        buf.WrOff = await this.processor.readMem32(buf.bufAddr + 12);

        let num_avail;
        if (buf.WrOff >= buf.RdOff) {
            num_avail = buf.SizeOfBuffer - (buf.WrOff - buf.RdOff);
        } else {
            num_avail = buf.RdOff - buf.WrOff - 1;
        }

        if (num_avail < data.length) {
            return -1; // Buffer full
        }

        for (let i = 0; i < data.length; i++) {
            await this.processor.writeMem8(buf.pBuffer + buf.WrOff, data[i]);
            if (++buf.WrOff === buf.SizeOfBuffer) {
                buf.WrOff = 0;
            }
        }
        await this.processor.writeMem32(buf.bufAddr + 12, buf.WrOff);

        return data.length;
    }

    getBufferInfo(bufId = 0, isUp = true) {
        if (!this.isInitialized) {
            return null;
        }

        const buf = isUp ? this.bufUp[bufId] : this.bufDown[bufId];
        if (!buf) {
            return null;
        }

        return {
            pBuffer: buf.pBuffer,
            SizeOfBuffer: buf.SizeOfBuffer,
            WrOff: buf.WrOff,
            RdOff: buf.RdOff,
            Flags: buf.Flags,
            used: buf.WrOff >= buf.RdOff ? (buf.WrOff - buf.RdOff) : (buf.SizeOfBuffer - buf.RdOff + buf.WrOff)
        };
    }
}
