/* =======================================
 * ========== 元数据处理模块 (metadata.js) ==========
 * ======================================= */

const KEYWORDS = ['FIGHT', 'PASTE', 'GRAFFITI', 'NORMAL', 'VIOLENCE', 'WEAPON', 'DANGER', 'THREAT'];
const textEncoder = new TextEncoder();
const exifHeaderBytes = textEncoder.encode("Exif\0\0");

function strToBytes(s) { return textEncoder.encode(s); }
function isJpeg(buf) { return buf && buf[0] === 0xFF && buf[1] === 0xD8; }
function isPng(buf) { return buf && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47; }

function isExifSegment(payload) {
    if (payload.length < 6) return false;
    for(let i=0; i<6; i++) {
        if (payload[i] !== exifHeaderBytes[i]) return false;
    }
    return true;
}

function findAllOccurrences(needleU8, hayU8) {
    const pos = [];
    for (let i = 0; i + needleU8.length <= hayU8.length; i++) {
        let ok = true;
        for (let j = 0; j < needleU8.length; j++) {
            if (hayU8[i + j] !== needleU8[j]) { ok = false; break; }
        }
        if (ok) pos.push(i);
    }
    return pos;
}

function padToLengthBytes(s, len) {
    const b = textEncoder.encode(s);
    if (b.length >= len) return b.slice(0, len);
    const out = new Uint8Array(len);
    out.set(b, 0);
    for (let i = b.length; i < len; i++) out[i] = 0x20;    
    return out;
}

function buildExifSegment(description) {
    const descBytes = textEncoder.encode(description + '\0');
    const descLen = descBytes.length;
    const tiffHeaderOffset = 6;
    const ifd0Offset = 8;
    const tagEntryCount = 1;
    const ifd0Size = 2 + (tagEntryCount * 12) + 4;
    const dataOffset = ifd0Offset + ifd0Size;
    const payloadLength = tiffHeaderOffset + ifd0Offset + ifd0Size + descLen;
    const segmentLength = payloadLength + 2;
    const segmentBuffer = new ArrayBuffer(segmentLength + 2);
    const view = new DataView(segmentBuffer);
    const u8 = new Uint8Array(segmentBuffer);
    view.setUint16(0, 0xFFE1, false);
    view.setUint16(2, segmentLength, false);
    u8.set(exifHeaderBytes, 4);
    const tiffOffset = 4 + tiffHeaderOffset;
    view.setUint16(tiffOffset, 0x4949, true);
    view.setUint16(tiffOffset + 2, 0x002A, true);
    view.setUint32(tiffOffset + 4, ifd0Offset, true);
    const ifd0Start = tiffOffset + ifd0Offset;
    view.setUint16(ifd0Start, tagEntryCount, true);
    const entryStart = ifd0Start + 2;
    view.setUint16(entryStart, 0x010E, true);
    view.setUint16(entryStart + 2, 2, true);
    view.setUint32(entryStart + 4, descLen, true);
    view.setUint32(entryStart + 8, dataOffset, true);
    view.setUint32(entryStart + 12, 0, true);
    const dataStart = tiffOffset + dataOffset;
    u8.set(descBytes, dataStart);
    return u8;
}

function processJpeg(u8, replacement) {
    let modified = u8.slice();
    let pos = 2;
    let replacedInExistingExif = false;

    while (pos + 4 <= modified.length) {
        if (modified[pos] !== 0xFF) { pos++; continue; }
        const marker = modified[pos + 1];
        if (marker === 0xDA) break;
        const segLen = (modified[pos + 2] << 8) + modified[pos + 3];
        if (segLen < 2) break;
        const payloadStart = pos + 4;
        const payloadEnd = pos + 2 + segLen;
        if (payloadEnd > modified.length) break;

        if (marker === 0xE1) {
            const payload = modified.subarray(payloadStart, payloadEnd);
            if (isExifSegment(payload)) {
                KEYWORDS.forEach(k => {
                    const kBytes = strToBytes(k);
                    const occurrences = findAllOccurrences(kBytes, payload);
                    occurrences.forEach(off => {
                        const globalOff = payloadStart + off;
                        const pad = padToLengthBytes(replacement, kBytes.length);
                        for (let i = 0; i < pad.length; i++) modified[globalOff + i] = pad[i];
                        replacedInExistingExif = true;
                    });
                });
            }
        }
        pos = payloadEnd;
    }

    if (replacedInExistingExif) return modified;

    const exifSeg = buildExifSegment(replacement);
    const soi = u8.subarray(0, 2);
    const restOfFile = u8.subarray(2);
    const out = new Uint8Array(soi.length + exifSeg.length + restOfFile.length);
    let p = 0;
    out.set(soi, p); p += soi.length;
    out.set(exifSeg, p); p += exifSeg.length;
    out.set(restOfFile, p);
    return out;
}

function crc32(buf) {
    let table = crc32.table;
    if (!table) {
        table = crc32.table = new Uint32Array(256);
        for (let i = 0; i < 256; i++) {
            let c = i;
            for (let k = 0; k < 8; k++) c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
            table[i] = c >>> 0;
        }
    }
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

function processPng(u8, replacement) {
    let pos = 8;
    let replaced = 0;
    
    while (pos + 8 <= u8.length) {
        const len = (u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3];
        const type = String.fromCharCode(u8[pos + 4], u8[pos + 5], u8[pos + 6], u8[pos + 7]);
        const dataStart = pos + 8;
        const dataEnd = dataStart + len;
        if (dataEnd > u8.length) break;

        const payload = u8.subarray(dataStart, dataEnd);
        if (type === 'tEXt' || type === 'iTXt' || type === 'zTXt') {
            KEYWORDS.forEach(k => {
                const kBytes = strToBytes(k);
                const occ = findAllOccurrences(kBytes, payload);
                occ.forEach(off => {
                    const globalOff = dataStart + off;
                    const pad = padToLengthBytes(replacement, kBytes.length);
                    for (let i = 0; i < pad.length; i++) u8[globalOff + i] = pad[i];
                    replaced++;
                });
            });
        }
        pos = dataEnd + 4;
    }

    if (replaced > 0) return u8;

    pos = 8;
    const ihdrLen = (u8[pos] << 24) | (u8[pos + 1] << 16) | (u8[pos + 2] << 8) | u8[pos + 3];
    const ihdrTotal = 4 + 4 + ihdrLen + 4;
    const before = u8.subarray(0, 8 + ihdrTotal);
    const after = u8.subarray(8 + ihdrTotal);

    function makeTextChunk(keyword, text) {
        const keyPayload = strToBytes(keyword + '\0' + text);
        const len = keyPayload.length;
        const chunk = new Uint8Array(4 + 4 + len + 4);
        const view = new DataView(chunk.buffer);
        view.setUint32(0, len, false);
        chunk[4] = 0x74; chunk[5] = 0x45; chunk[6] = 0x58; chunk[7] = 0x74; // 'tEXt'
        chunk.set(keyPayload, 8);
        const crc = crc32(chunk.subarray(4, 8 + len));
        view.setUint32(8 + len, crc, false);
        return chunk;
    }

    const chunks = [makeTextChunk('Adversarial-Tag', replacement)];
    const totalLen = before.length + chunks.reduce((s, c) => s + c.length, 0) + after.length;
    const out = new Uint8Array(totalLen);
    let p = 0;
    out.set(before, p); p += before.length;
    chunks.forEach(c => { out.set(c, p); p += c.length; });
    out.set(after, p);
    return out;
}

// 导出公共接口
window.metadataAPI = {
    isJpeg,
    isPng,
    processJpeg,
    processPng
};
