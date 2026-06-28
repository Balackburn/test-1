// Loss-less SFNT (TrueType/OpenType) `name` table editor.
//
// TypeRip downloads each weight of a family as its own font whose internal
// family name includes the weight (e.g. "Futura PT Light"), so the OS installs
// them as separate families: "Futura PT Light", "Futura PT Bold", ... This
// module rewrites ONLY the `name` table so every weight shares one family name
// ("Futura PT") with the weight as its style ("Light", "Bold"), making them
// install and group as a single family.
//
// Every other table (glyf/CFF/loca/kern/GPOS/GSUB/OS-2/...) is copied byte for
// byte, so glyph outlines, kerning and OpenType features are preserved exactly —
// this is why we edit the binary directly instead of round-tripping through a
// font library.

const NAME_ID = {
    FAMILY: 1,          // Font Family name (RIBBI grouping)
    SUBFAMILY: 2,       // Font Subfamily name
    FULL: 4,            // Full font name
    POSTSCRIPT: 6,      // PostScript name
    TYPO_FAMILY: 16,    // Typographic Family name (used for grouping by modern apps)
    TYPO_SUBFAMILY: 17, // Typographic Subfamily name
};

const TARGET_IDS = new Set(Object.values(NAME_ID));

function encodeNameValue(platformID, value) {
    if (platformID === 1) {
        // Macintosh Roman — ASCII is a safe subset for Latin family/style names.
        const out = new Uint8Array(value.length);
        for (let i = 0; i < value.length; i++) out[i] = value.charCodeAt(i) & 0x7f;
        return out;
    }
    // Windows (3) and Unicode (0) records use UTF-16BE.
    const out = new Uint8Array(value.length * 2);
    for (let i = 0; i < value.length; i++) {
        const c = value.charCodeAt(i);
        out[i * 2] = (c >> 8) & 0xff;
        out[i * 2 + 1] = c & 0xff;
    }
    return out;
}

// PostScript names must be ASCII, contain none of (){}[]<>/% or whitespace, and
// be at most 63 characters.
function sanitizePostScript(s) {
    let out = "";
    for (const ch of s) {
        const c = ch.charCodeAt(0);
        if (c < 33 || c > 126) continue;
        if ("(){}[]<>/% ".includes(ch)) continue;
        out += ch;
    }
    return out.slice(0, 63) || "Font-Regular";
}

function parseSfnt(buf) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const sfntVersion = dv.getUint32(0);
    const numTables = dv.getUint16(4);
    const tables = [];
    let p = 12;
    for (let i = 0; i < numTables; i++) {
        const tag = String.fromCharCode(buf[p], buf[p + 1], buf[p + 2], buf[p + 3]);
        const offset = dv.getUint32(p + 8);
        const length = dv.getUint32(p + 12);
        tables.push({ tag, data: buf.slice(offset, offset + length) });
        p += 16;
    }
    return { sfntVersion, tables };
}

function parseNameRecords(table) {
    const dv = new DataView(table.buffer, table.byteOffset, table.byteLength);
    const count = dv.getUint16(2);
    const storageOffset = dv.getUint16(4);
    const records = [];
    let p = 6;
    for (let i = 0; i < count; i++) {
        const platformID = dv.getUint16(p);
        const encodingID = dv.getUint16(p + 2);
        const languageID = dv.getUint16(p + 4);
        const nameID = dv.getUint16(p + 6);
        const length = dv.getUint16(p + 8);
        const offset = dv.getUint16(p + 10);
        const bytes = table.slice(storageOffset + offset, storageOffset + offset + length);
        records.push({ platformID, encodingID, languageID, nameID, bytes });
        p += 12;
    }
    return records;
}

// Serialize records as a format-0 name table. Records with language-tag indices
// (languageID >= 0x8000, only meaningful with the format-1 lang-tag array we
// drop) are filtered out; these are extremely rare.
function buildNameTable(records) {
    records = records
        .filter((r) => r.languageID < 0x8000)
        .sort(
            (a, b) =>
                a.platformID - b.platformID ||
                a.encodingID - b.encodingID ||
                a.languageID - b.languageID ||
                a.nameID - b.nameID
        );

    const count = records.length;
    const headerSize = 6 + count * 12;
    const storageLen = records.reduce((n, r) => n + r.bytes.length, 0);
    const out = new Uint8Array(headerSize + storageLen);
    const dv = new DataView(out.buffer);

    dv.setUint16(0, 0); // format 0
    dv.setUint16(2, count);
    dv.setUint16(4, headerSize); // storage starts right after the records

    let p = 6;
    let so = 0;
    for (const r of records) {
        dv.setUint16(p, r.platformID);
        dv.setUint16(p + 2, r.encodingID);
        dv.setUint16(p + 4, r.languageID);
        dv.setUint16(p + 6, r.nameID);
        dv.setUint16(p + 8, r.bytes.length);
        dv.setUint16(p + 10, so);
        out.set(r.bytes, headerSize + so);
        so += r.bytes.length;
        p += 12;
    }
    return out;
}

const pad4 = (n) => (n + 3) & ~3;

function calcChecksum(data) {
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
        const b0 = data[i] || 0;
        const b1 = data[i + 1] || 0;
        const b2 = data[i + 2] || 0;
        const b3 = data[i + 3] || 0;
        sum = (sum + (((b0 << 24) >>> 0) + (b1 << 16) + (b2 << 8) + b3)) >>> 0;
    }
    return sum >>> 0;
}

function serializeSfnt(sfnt) {
    const tables = sfnt.tables
        .slice()
        .sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
    const numTables = tables.length;

    // The head table's checksumAdjustment must be zero while checksums are
    // computed, then set to the final value afterwards.
    const head = tables.find((t) => t.tag === "head");
    if (head) {
        new DataView(head.data.buffer, head.data.byteOffset, head.data.byteLength).setUint32(8, 0);
    }

    const headerSize = 12 + numTables * 16;
    let offset = headerSize;
    const entries = [];
    for (const t of tables) {
        entries.push({ tag: t.tag, data: t.data, offset, length: t.data.length, checksum: calcChecksum(t.data) });
        offset += pad4(t.data.length);
    }

    const out = new Uint8Array(offset);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, sfnt.sfntVersion);
    dv.setUint16(4, numTables);

    let maxPow = 1;
    let entrySelector = 0;
    while (maxPow * 2 <= numTables) {
        maxPow *= 2;
        entrySelector++;
    }
    const searchRange = maxPow * 16;
    dv.setUint16(6, searchRange);
    dv.setUint16(8, entrySelector);
    dv.setUint16(10, numTables * 16 - searchRange);

    let p = 12;
    for (const e of entries) {
        out[p] = e.tag.charCodeAt(0);
        out[p + 1] = e.tag.charCodeAt(1);
        out[p + 2] = e.tag.charCodeAt(2);
        out[p + 3] = e.tag.charCodeAt(3);
        dv.setUint32(p + 4, e.checksum >>> 0);
        dv.setUint32(p + 8, e.offset);
        dv.setUint32(p + 12, e.length);
        p += 16;
    }
    for (const e of entries) out.set(e.data, e.offset);

    if (head) {
        const headEntry = entries.find((e) => e.tag === "head");
        const adjustment = (0xb1b0afba - calcChecksum(out)) >>> 0;
        dv.setUint32(headEntry.offset + 8, adjustment);
    }

    return out;
}

// Rewrite a font so it belongs to `familyName` with style `styleName`.
// `ttf` is a Uint8Array; returns a new Uint8Array. On any parse problem it
// returns the input unchanged so a download still succeeds.
export function renameFontFamily(ttf, familyName, styleName) {
    try {
        familyName = (familyName || "").trim();
        styleName = (styleName || "Regular").trim() || "Regular";

        const sfnt = parseSfnt(ttf);
        const nameTable = sfnt.tables.find((t) => t.tag === "name");
        if (!nameTable || !familyName) return ttf;

        const records = parseNameRecords(nameTable.data);

        const fullName = `${familyName} ${styleName}`.trim();
        const overrides = {
            [NAME_ID.FAMILY]: familyName,
            [NAME_ID.SUBFAMILY]: styleName,
            [NAME_ID.FULL]: fullName,
            [NAME_ID.POSTSCRIPT]: sanitizePostScript(`${familyName}-${styleName}`),
            [NAME_ID.TYPO_FAMILY]: familyName,
            [NAME_ID.TYPO_SUBFAMILY]: styleName,
        };

        // Replace the strings of existing target records, in their own encoding.
        for (const r of records) {
            if (TARGET_IDS.has(r.nameID)) {
                r.bytes = encodeNameValue(r.platformID, overrides[r.nameID]);
            }
        }

        // Ensure typographic family/subfamily (16/17) exist for every platform
        // that has a family (1) record — these drive grouping in modern apps.
        const familyRecs = records.filter((r) => r.nameID === NAME_ID.FAMILY);
        for (const id of [NAME_ID.TYPO_FAMILY, NAME_ID.TYPO_SUBFAMILY]) {
            for (const fr of familyRecs) {
                const exists = records.some(
                    (r) =>
                        r.nameID === id &&
                        r.platformID === fr.platformID &&
                        r.encodingID === fr.encodingID &&
                        r.languageID === fr.languageID
                );
                if (!exists) {
                    records.push({
                        platformID: fr.platformID,
                        encodingID: fr.encodingID,
                        languageID: fr.languageID,
                        nameID: id,
                        bytes: encodeNameValue(fr.platformID, overrides[id]),
                    });
                }
            }
        }

        nameTable.data = buildNameTable(records);
        return serializeSfnt(sfnt);
    } catch (e) {
        console.warn("renameFontFamily failed, using original font:", e);
        return ttf;
    }
}
