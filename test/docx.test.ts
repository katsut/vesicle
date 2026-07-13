// Unit tests for the zero-dependency .docx reader (src/docx.ts): a hand-rolled single-entry ZIP
// proves the parser end-to-end — local header, central directory, EOCD — with no fixture files.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { docxToText } from "../src/docx.ts";

// Build a one-entry ZIP: [local header + name + extra + data][central directory][EOCD]. The LOCAL
// extra field is deliberately NON-empty while the central directory's is empty — the two lengths
// legitimately differ, and a parser that locates data with the central lengths reads garbage.
function zipWith(entryName: string, xml: string, opts: { stored?: boolean } = {}): Buffer {
  const name = Buffer.from(entryName, "utf8");
  const raw = Buffer.from(xml, "utf8");
  const data = opts.stored ? raw : deflateRawSync(raw);
  const method = opts.stored ? 0 : 8;
  // an extended-timestamp ("UT") extra field, present ONLY in the local header
  const localExtra = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header signature
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(0, 10); // mod time
  local.writeUInt16LE(0, 12); // mod date
  local.writeUInt32LE(0, 14); // crc32 (unchecked by the reader)
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(raw.length, 22); // uncompressed size
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(localExtra.length, 28);
  const localRecord = Buffer.concat([local, name, localExtra, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central directory header signature
  central.writeUInt16LE(20, 4); // version made by
  central.writeUInt16LE(20, 6); // version needed
  central.writeUInt16LE(0, 8); // flags
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(0, 12); // mod time
  central.writeUInt16LE(0, 14); // mod date
  central.writeUInt32LE(0, 16); // crc32
  central.writeUInt32LE(data.length, 20); // compressed size
  central.writeUInt32LE(raw.length, 24); // uncompressed size
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30); // central extra: EMPTY — differs from the local header's on purpose
  central.writeUInt16LE(0, 32); // comment length
  central.writeUInt16LE(0, 34); // disk number start
  central.writeUInt16LE(0, 36); // internal attributes
  central.writeUInt32LE(0, 38); // external attributes
  central.writeUInt32LE(0, 42); // local header offset (the entry starts the file)
  const centralRecord = Buffer.concat([central, name]);

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(1, 8); // entries on this disk
  eocd.writeUInt16LE(1, 10); // entries total
  eocd.writeUInt32LE(centralRecord.length, 12); // central directory size
  eocd.writeUInt32LE(localRecord.length, 16); // central directory offset
  return Buffer.concat([localRecord, centralRecord, eocd]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const docx = (body: string, opts?: { stored?: boolean }): Buffer =>
  zipWith("word/document.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>`, opts);

test("docxToText: paragraphs and runs extract with line breaks (empty paragraphs collapse)", () => {
  const body =
    "<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Rule 1</w:t></w:r>" +
    '<w:r><w:t xml:space="preserve"> applies to everyone.</w:t></w:r></w:p>' +
    "<w:p/><w:p/><w:p/>" + // a run of empty paragraphs reads as ONE blank line
    "<w:p><w:r><w:t>Rule 2</w:t></w:r></w:p>";
  assert.equal(docxToText(docx(body)), "Rule 1 applies to everyone.\n\nRule 2");
});

test("docxToText: the five XML entities and numeric references decode", () => {
  const body = "<w:p><w:r><w:t>a &amp; b &lt;c&gt; &quot;d&quot; &apos;e&apos; &#65;&#x42;</w:t></w:r></w:p>";
  assert.equal(docxToText(docx(body)), "a & b <c> \"d\" 'e' AB");
});

test("docxToText: <w:tab/> becomes a tab, <w:br/> a newline", () => {
  const body = '<w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t><w:br w:type="textWrapping"/><w:t>c</w:t></w:r></w:p>';
  assert.equal(docxToText(docx(body)), "a\tb\nc");
});

test("docxToText: a stored (method 0) entry reads verbatim", () => {
  const body = "<w:p><w:r><w:t>stored, not deflated</w:t></w:r></w:p>";
  assert.equal(docxToText(docx(body, { stored: true })), "stored, not deflated");
});

test("docxToText: an archive without word/document.xml throws", () => {
  const zip = zipWith("word/styles.xml", `<w:styles ${W}/>`);
  assert.throws(() => docxToText(zip), /word\/document\.xml/);
});

test("docxToText: a non-ZIP buffer throws", () => {
  assert.throws(() => docxToText(Buffer.from("plain text, no ZIP structure here")), /end-of-central-directory/);
});
