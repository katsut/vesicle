// Minimal .xlsx → per-sheet string rows for the Drive body lane, zero dependencies.
//
// A .xlsx is the same ZIP/XML family as .docx (docx.ts, whose member reader carries the
// local-header lesson), but the content spans several members instead of one: the sheet list (names
// + order) lives in xl/workbook.xml, each sheet's rId resolves to its member path through
// xl/_rels/workbook.xml.rels, deduplicated cell text sits in xl/sharedStrings.xml, and the grids in
// xl/worksheets/*.xml. This module reads them all locally (the Drive scope is read-only, so
// server-side conversion is unavailable — see docx.ts) and emits plain string rows:
//
//   1. Cells: t="s" resolves the shared-string table, t="inlineStr" reads <is> text, everything
//      else takes <v>'s raw text — numbers and date serials stay raw in v1 (a date reads as e.g.
//      "45292"; the numFmt style table is not consulted). A formula cell contributes its cached
//      <v> result, never the <f> formula.
//   2. Positions: the r="B3" cell reference is honored — a skipped cell reads as "", a skipped row
//      as [], and trailing empty cells/rows are trimmed so sparse sheets stay compact.
//   3. Not read: styles/number formats, merged-cell spans, hyperlinks, comments, charts — the
//      output is best-effort text for LLM extraction, not a spreadsheet converter.

import { decodeEntities, readZipMember } from "./docx.ts";

/** The decoded value of one attribute in a tag's attribute text, or null when absent. */
function attrOf(attrs: string, name: string): string | null {
  const m = new RegExp(`(?:^|\\s)${name}="([^"]*)"`).exec(attrs);
  return m ? decodeEntities(m[1]!) : null;
}

const T_RE = /<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g;

/** All <t> content inside an <si> or <is> fragment, concatenated (rich text splits one string
 *  across runs). Phonetic runs (<rPh>, furigana readings) duplicate the base text, so they go. */
function textOf(fragment: string): string {
  const base = fragment.replace(/<rPh(?:\s[^>]*)?>[\s\S]*?<\/rPh>/g, "");
  let out = "";
  for (const m of base.matchAll(T_RE)) out += decodeEntities(m[1]!);
  return out;
}

/** The shared-string table, in index order (cells with t="s" hold indexes into it). */
function parseSharedStrings(xml: string): string[] {
  const out: string[] = [];
  for (const m of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) out.push(textOf(m[1]!));
  return out;
}

/** "B3" → 1: the 0-based column of a cell reference, or null when it has no column letters. */
function colOf(ref: string): number | null {
  let col = 0;
  let i = 0;
  for (; i < ref.length; i++) {
    const c = ref.charCodeAt(i);
    if (c < 65 || c > 90) break; // 'A'..'Z'
    col = col * 26 + (c - 64);
  }
  return i > 0 ? col - 1 : null;
}

// Rows and cells both come self-closing when empty (<row r="2"/>, <c r="A1" s="1"/>), so the tag
// regexes accept both forms — a content-only pattern would swallow everything up to a LATER close.
const ROW_RE = /<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g;
const CELL_RE = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
const V_RE = /<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/;

/** One worksheet member's grid. `path` names the member in corrupt-archive errors. */
function parseSheet(xml: string, shared: string[], path: string): string[][] {
  const rows: string[][] = [];
  let lastRow = 0;
  for (const rm of xml.matchAll(ROW_RE)) {
    // r is 1-based and optional; a sheet may also skip whole rows — the gap reads as empty rows
    const rAttr = Number(attrOf(rm[1]!, "r") ?? NaN);
    const rowNum = Number.isInteger(rAttr) && rAttr > 0 ? rAttr : lastRow + 1;
    const cells: string[] = [];
    let lastCol = -1;
    for (const cm of (rm[2] ?? "").matchAll(CELL_RE)) {
      const attrs = cm[1]!;
      const ref = attrOf(attrs, "r");
      const col = (ref != null ? colOf(ref) : null) ?? lastCol + 1;
      lastCol = col;
      const t = attrOf(attrs, "t") ?? "n";
      let val = "";
      const inner = cm[2];
      if (inner) {
        if (t === "inlineStr") {
          val = textOf(inner);
        } else {
          const v = V_RE.exec(inner);
          if (v) {
            const raw = decodeEntities(v[1]!);
            if (t === "s") {
              const s = shared[Number(raw)];
              if (s === undefined) throw new Error(`corrupt .xlsx: shared string index ${raw} out of range in ${path}`);
              val = s;
            } else {
              // t="n" (default) and untyped cells: numbers and DATE SERIALS stay raw — v1 reads no
              // number formats. t="str" is a formula's cached string, t="b" 0/1, t="e" "#DIV/0!".
              val = raw;
            }
          }
        }
      }
      while (cells.length < col) cells.push(""); // skipped cells read as ""
      cells[col] = val;
    }
    while (cells.length && cells[cells.length - 1] === "") cells.pop(); // trailing empties trimmed
    while (rows.length < rowNum - 1) rows.push([]);
    rows[rowNum - 1] = cells;
    lastRow = rowNum;
  }
  while (rows.length && rows[rows.length - 1]!.length === 0) rows.pop(); // trailing empty rows too
  return rows;
}

/** A .xlsx workbook's sheets as plain string grids, in workbook (tab) order. Throws on a non-ZIP
 *  or encrypted buffer, an archive that is not a workbook, or a workbook with dangling sheet refs. */
export function xlsxToRows(buf: Buffer): { sheet: string; rows: string[][] }[] {
  // A password-protected .xlsx is not a ZIP at all — it is an OLE/CFB container wrapping an
  // EncryptedPackage stream. Catch its magic up front for a readable error instead of "not a ZIP".
  if (buf.length >= 8 && buf.readUInt32LE(0) === 0xe011cfd0 && buf.readUInt32LE(4) === 0xe11ab1a1) {
    throw new Error("encrypted .xlsx: password-protected workbooks cannot be read");
  }
  const wb = readZipMember(buf, "xl/workbook.xml");
  if (wb == null) throw new Error("not a .xlsx: the archive has no xl/workbook.xml");
  const rels = readZipMember(buf, "xl/_rels/workbook.xml.rels");
  if (rels == null) throw new Error("not a .xlsx: the archive has no xl/_rels/workbook.xml.rels");
  const sst = readZipMember(buf, "xl/sharedStrings.xml"); // absent when no cell needs it
  const shared = sst ? parseSharedStrings(sst.toString("utf8")) : [];

  // rId → member path. Relationship targets are relative to the source part's folder (xl/);
  // a rooted target ("/xl/…") is already package-absolute.
  const targets = new Map<string, string>();
  for (const m of rels.toString("utf8").matchAll(/<Relationship\b([^>]*?)\/?>/g)) {
    const id = attrOf(m[1]!, "Id");
    const target = attrOf(m[1]!, "Target");
    if (id && target) targets.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }

  const sheets: { sheet: string; rows: string[][] }[] = [];
  for (const m of wb.toString("utf8").matchAll(/<sheet\b([^>]*?)\/?>/g)) {
    const name = attrOf(m[1]!, "name");
    const rid = attrOf(m[1]!, "r:id");
    if (name == null || rid == null) continue;
    const path = targets.get(rid);
    if (!path) throw new Error(`corrupt .xlsx: sheet "${name}" has no ${rid} relationship in workbook.xml.rels`);
    const ws = readZipMember(buf, path);
    if (ws == null) throw new Error(`corrupt .xlsx: sheet "${name}" points at missing member ${path}`);
    sheets.push({ sheet: name, rows: parseSheet(ws.toString("utf8"), shared, path) });
  }
  if (!sheets.length) throw new Error("not a .xlsx: xl/workbook.xml lists no sheets");
  return sheets;
}

/** Sheets → the compact text handed to extraction: a "# <sheet>" heading per sheet, one
 *  tab-separated line per row. Tabs/newlines INSIDE a cell flatten to a space so the grid holds. */
export function sheetsToText(sheets: { sheet: string; rows: string[][] }[]): string {
  return sheets
    .map((s) => [`# ${s.sheet}`, ...s.rows.map((r) => r.map((c) => c.replace(/[\t\r\n]+/g, " ")).join("\t"))].join("\n"))
    .join("\n\n");
}
