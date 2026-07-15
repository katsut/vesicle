// Minimal .docx → plain text for the Drive body lane, zero dependencies.
//
// A .docx is a ZIP archive whose whole document body lives in ONE member, word/document.xml. The
// connector's Drive scope is read-only, so server-side conversion (files.copy) is unavailable —
// the bytes come down as-is (alt=media) and this module unwraps them locally:
//
//   1. ZIP: locate the end-of-central-directory record (scan from the tail — it ends in a
//      variable-length comment), walk the central directory to word/document.xml, then read the
//      member through its LOCAL header (whose name/extra lengths can differ from the central
//      directory's) and inflate (method 8) or take the bytes verbatim (method 0, stored).
//   2. XML → text: <w:t> runs carry all human text; a paragraph end becomes a line break, <w:tab/>
//      a tab, <w:br/> a newline; every other tag is dropped. No XML parser — a token scan over the
//      one well-formed file keeps dependencies at zero. The tradeoff: the output is best-effort
//      text for LLM extraction, not a converter — tables flatten to paragraph order, and
//      headers/footers/footnotes (other ZIP members) are not read.

import { inflateRawSync } from "node:zlib";

const EOCD_SIG = 0x06054b50; // end of central directory
const CDIR_SIG = 0x02014b50; // central directory file header
const LOCAL_SIG = 0x04034b50; // local file header

/** One named member's decompressed bytes, or null when the archive has no such member.
 *  Exported for xlsx.ts — a .xlsx is the same ZIP container, just with more members. */
export function readZipMember(buf: Buffer, wanted: string): Buffer | null {
  // The EOCD record is 22 bytes plus a trailing comment — scan backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a ZIP archive (no end-of-central-directory record)");
  const entries = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < entries && off + 46 <= buf.length && buf.readUInt32LE(off) === CDIR_SIG; i++) {
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    if (buf.toString("utf8", off + 46, off + 46 + nameLen) === wanted) {
      if (localOff + 30 > buf.length || buf.readUInt32LE(localOff) !== LOCAL_SIG) {
        throw new Error(`corrupt ZIP: bad local file header for ${wanted}`);
      }
      // The data sits after the LOCAL header's own name+extra fields — their lengths can
      // legitimately differ from the central directory's (extra fields are often one-sided).
      const dataOff = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
      const data = buf.subarray(dataOff, dataOff + compressedSize);
      if (method === 8) return inflateRawSync(data);
      if (method === 0) return data;
      throw new Error(`unsupported ZIP compression method ${method} for ${wanted}`);
    }
    off += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

/** The five predefined XML entities plus numeric character references. Exported for xlsx.ts. */
export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(amp|lt|gt|quot|apos|#x[0-9a-fA-F]+|#\d+);/g, (whole, ref: string) => {
    switch (ref) {
      case "amp":
        return "&";
      case "lt":
        return "<";
      case "gt":
        return ">";
      case "quot":
        return '"';
      case "apos":
        return "'";
    }
    const cp = ref[1] === "x" ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
    return cp <= 0x10ffff ? String.fromCodePoint(cp) : whole;
  });
}

// One pass over document.xml: <w:t> runs contribute their decoded content; a paragraph end
// (</w:p> or self-closing <w:p/>) and <w:br/> contribute a newline, <w:tab/> a tab. Everything
// else — formatting, tables, section properties — is dropped.
const TOKEN_RE = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*\/>|<w:br\b[^>]*\/>|<\/w:p>|<w:p\b[^>]*\/>/g;

function documentXmlToText(xml: string): string {
  let out = "";
  for (const m of xml.matchAll(TOKEN_RE)) {
    if (m[1] !== undefined) out += decodeEntities(m[1]);
    else if (m[0].startsWith("<w:tab")) out += "\t";
    else out += "\n"; // </w:p>, <w:p/>, <w:br/>
  }
  // runs of empty paragraphs read as ONE blank line
  return out.replace(/\n{3,}/g, "\n\n").trim();
}

/** A .docx file's body as best-effort plain text. Throws on a non-ZIP buffer, an unsupported
 *  compression method, or an archive without word/document.xml. */
export function docxToText(buf: Buffer): string {
  const xml = readZipMember(buf, "word/document.xml");
  if (xml == null) throw new Error("not a .docx: the archive has no word/document.xml");
  return documentXmlToText(xml.toString("utf8"));
}
