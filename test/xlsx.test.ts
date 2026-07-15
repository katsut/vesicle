// Unit tests for the zero-dependency .xlsx reader (src/xlsx.ts): a hand-rolled multi-entry ZIP
// (docx.test.ts's single-entry writer, generalized) proves the parser end-to-end — workbook sheet
// list, rels resolution, shared strings, worksheet grids — with no fixture files.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { deflateRawSync } from "node:zlib";
import { sheetsToText, xlsxToRows } from "../src/xlsx.ts";

// Build an N-entry ZIP: [local header + name + extra + data]*N [central directory][EOCD]. As in
// docx.test.ts, each LOCAL extra field is deliberately NON-empty while the central directory's is
// empty — a parser that locates data with the central lengths reads garbage.
function zipOf(entries: Array<{ name: string; content: string }>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const raw = Buffer.from(e.content, "utf8");
    const data = deflateRawSync(raw);
    // an extended-timestamp ("UT") extra field, present ONLY in the local header
    const localExtra = Buffer.from([0x55, 0x54, 0x05, 0x00, 0x03, 0x00, 0x00, 0x00, 0x00]);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
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
    central.writeUInt16LE(8, 10); // method: deflate
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
    central.writeUInt32LE(offset, 42); // this entry's local header offset
    centrals.push(Buffer.concat([central, name]));
    locals.push(localRecord);
    offset += localRecord.length;
  }
  const centralAll = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD signature
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // entries total
  eocd.writeUInt32LE(centralAll.length, 12); // central directory size
  eocd.writeUInt32LE(offset, 16); // central directory offset
  return Buffer.concat([...locals, centralAll, eocd]);
}

// --- .xlsx member fixtures (namespaces as Excel writes them) ---------------------------------------

const MAIN_NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const workbookXml = (names: string[]): string =>
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook ${MAIN_NS}><sheets>${names
    .map((n, i) => `<sheet name="${n}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join("")}</sheets></workbook>`;

const relsXml = (targets: string[]): string =>
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${targets
    .map((t, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${t}"/>`)
    .join("")}</Relationships>`;

const sheetXml = (rows: string): string => `<worksheet ${MAIN_NS}><sheetData>${rows}</sheetData></worksheet>`;

/** A one-sheet workbook around the given <row> markup, plus optional shared-string <si> entries. */
function xlsxOf(rows: string, shared?: string): Buffer {
  const entries = [
    { name: "xl/workbook.xml", content: workbookXml(["Sheet1"]) },
    { name: "xl/_rels/workbook.xml.rels", content: relsXml(["worksheets/sheet1.xml"]) },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml(rows) },
  ];
  if (shared !== undefined) entries.push({ name: "xl/sharedStrings.xml", content: `<sst ${MAIN_NS} count="9" uniqueCount="9">${shared}</sst>` });
  return zipOf(entries);
}

test("xlsxToRows: shared strings resolve — rich-text runs concatenate, phonetic runs drop, entities decode", () => {
  const shared =
    "<si><t>Name</t></si>" +
    "<si><r><rPr><b/></rPr><t>Ali</t></r><r><t>ce</t></r></si>" + // rich text: one string, two runs
    '<si><r><t>Bob &amp; Co</t></r><rPh sb="0" eb="3"><t>ボブ</t></rPh><phoneticPr fontId="1"/></si>';
  const rows =
    '<row r="1"><c r="A1" t="s"><v>0</v></c></row>' +
    '<row r="2"><c r="A2" t="s"><v>1</v></c><c r="B2" t="s"><v>2</v></c></row>';
  assert.deepEqual(xlsxToRows(xlsxOf(rows, shared)), [{ sheet: "Sheet1", rows: [["Name"], ["Alice", "Bob & Co"]] }]);
});

test("xlsxToRows: inline strings (t=\"inlineStr\") read from <is>", () => {
  const rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c><c r="B1" t="inlineStr"><is><r><t>a</t></r><r><t>b</t></r></is></c></row>';
  assert.deepEqual(xlsxToRows(xlsxOf(rows)), [{ sheet: "Sheet1", rows: [["Total", "ab"]] }]);
});

test("xlsxToRows: numbers and date serials stay raw; a formula cell contributes its cached <v>", () => {
  const rows =
    '<row r="1"><c r="A1"><v>42</v></c><c r="B1" t="n"><v>3.14</v></c><c r="C1"><v>45292</v></c></row>' + // 45292 = a date serial, raw by design
    '<row r="2"><c r="A2"><f>A1*2</f><v>84</v></c><c r="B2" t="str"><f>CONCATENATE("o","k")</f><v>ok</v></c></row>';
  assert.deepEqual(xlsxToRows(xlsxOf(rows)), [{ sheet: "Sheet1", rows: [["42", "3.14", "45292"], ["84", "ok"]] }]);
});

test("xlsxToRows: cell references are honored — gaps fill with \"\", trailing empties trim, skipped rows read empty", () => {
  const rows =
    '<row r="1"><c r="B1"><v>1</v></c><c r="D1"><v>2</v></c><c r="E1" s="3"/></row>' + // A/C skipped, E valueless
    '<row r="2" spans="1:5"/>' + // an empty self-closing row must not swallow the next one
    '<row r="4"><c r="A4"><v>3</v></c></row>'; // row 3 skipped entirely
  assert.deepEqual(xlsxToRows(xlsxOf(rows)), [{ sheet: "Sheet1", rows: [["", "1", "", "2"], [], [], ["3"]] }]);
});

test("xlsxToRows: multiple sheets keep workbook order and resolve rIds through the rels (even crossed)", () => {
  // rId1 → sheet2.xml and rId2 → sheet1.xml: order must come from the workbook + rels, not filenames
  const zip = zipOf([
    { name: "xl/workbook.xml", content: workbookXml(["P&amp;L", "Data"]) },
    { name: "xl/_rels/workbook.xml.rels", content: relsXml(["worksheets/sheet2.xml", "/xl/worksheets/sheet1.xml"]) },
    { name: "xl/worksheets/sheet1.xml", content: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>second</t></is></c></row>') },
    { name: "xl/worksheets/sheet2.xml", content: sheetXml('<row r="1"><c r="A1" t="inlineStr"><is><t>first</t></is></c></row>') },
  ]);
  assert.deepEqual(xlsxToRows(zip), [
    { sheet: "P&L", rows: [["first"]] },
    { sheet: "Data", rows: [["second"]] },
  ]);
});

test("sheetsToText: '# <sheet>' headings + TSV rows; in-cell tabs/newlines flatten to spaces", () => {
  const sheets = [
    { sheet: "Roles", rows: [["role", "owner"], ["approver", "Alice\nBob"]] },
    { sheet: "Empty", rows: [] as string[][] },
  ];
  assert.equal(sheetsToText(sheets), "# Roles\nrole\towner\napprover\tAlice Bob\n\n# Empty");
});

test("xlsxToRows: an archive without xl/workbook.xml throws", () => {
  const zip = zipOf([{ name: "word/document.xml", content: "<w:document/>" }]);
  assert.throws(() => xlsxToRows(zip), /xl\/workbook\.xml/);
});

test("xlsxToRows: a workbook whose sheet rId is missing from the rels throws", () => {
  const zip = zipOf([
    { name: "xl/workbook.xml", content: workbookXml(["Sheet1"]) },
    { name: "xl/_rels/workbook.xml.rels", content: relsXml([]) },
  ]);
  assert.throws(() => xlsxToRows(zip), /no rId1 relationship/);
});

test("xlsxToRows: a shared-string index out of range throws", () => {
  const rows = '<row r="1"><c r="A1" t="s"><v>7</v></c></row>';
  assert.throws(() => xlsxToRows(xlsxOf(rows, "<si><t>only</t></si>")), /shared string index 7/);
});

test("xlsxToRows: a non-ZIP buffer throws", () => {
  assert.throws(() => xlsxToRows(Buffer.from("plain text, no ZIP structure here")), /end-of-central-directory/);
});

test("xlsxToRows: an encrypted (OLE/CFB) workbook throws a readable error", () => {
  const cfb = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
  assert.throws(() => xlsxToRows(cfb), /encrypted/);
});
