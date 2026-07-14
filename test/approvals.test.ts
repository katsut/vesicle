// Unit tests for the deterministic half of approval detection (src/approvals.ts): the tiered
// pattern scan — Japanese substrings, word-boundary Latin tokens, the negation/conditional/question
// guards, and snippet windowing. Pure function — no engine, no server.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { matchApproval } from "../src/approvals.ts";

test("matchApproval: Japanese formal phrases hit as substrings", () => {
  const m = matchApproval("上記の内容で承認します。");
  assert.ok(m);
  assert.equal(m.tier, "formal");
  assert.equal(m.pattern, "承認します");
  assert.equal(m.snippet, "上記の内容で承認します。"); // short text — the whole comment is the window

  assert.equal(matchApproval("承認いたします。よろしくお願いします。")?.pattern, "承認いたします");
  assert.equal(matchApproval("先ほど承認しました。")?.pattern, "承認しました");
  assert.equal(matchApproval("この内容で承認です。")?.pattern, "承認です");
});

test("matchApproval: Latin tokens hit on word boundaries, case-insensitively", () => {
  assert.equal(matchApproval("LGTM!")?.pattern, "LGTM");
  assert.equal(matchApproval("lgtm")?.pattern, "LGTM"); // reported as the configured pattern
  assert.equal(matchApproval("Looks good — approved.")?.pattern, "approved");
  assert.equal(matchApproval("Approval Granted per the review.")?.pattern, "approval granted");
});

test("matchApproval: word boundaries prevent hits inside longer words", () => {
  assert.equal(matchApproval("approvedly speaking, this needs work"), null); // not "approved"
  assert.equal(matchApproval("I disapprove of this change"), null); // not "approve"
  assert.equal(matchApproval("the approval process is slow"), null); // only the full "approval granted" phrase is a pattern
});

test("matchApproval: euphemisms hit as the weak tier", () => {
  const m = matchApproval("修正文で進めていただいて大丈夫です");
  assert.ok(m);
  assert.equal(m.tier, "euphemism");

  assert.equal(matchApproval("こちらで問題ありません")?.tier, "euphemism");
  assert.equal(matchApproval("その方針で進めてください")?.tier, "euphemism");
});

test("matchApproval: a formal hit wins when both tiers match", () => {
  const m = matchApproval("問題ありません。承認します。");
  assert.ok(m);
  assert.equal(m.tier, "formal");
  assert.equal(m.pattern, "承認します");
});

test("matchApproval: questions are not approvals (both tiers)", () => {
  assert.equal(matchApproval("この内容で承認しますか"), null);
  assert.equal(matchApproval("こちらで大丈夫ですか？"), null);
  assert.equal(matchApproval("この案で問題ありませんか。"), null);
  assert.equal(matchApproval("Can you approve this?"), null);
});

test("matchApproval: a guarded occurrence does not veto a later clean one", () => {
  const m = matchApproval("大丈夫ですか？はい、大丈夫です。");
  assert.ok(m);
  assert.equal(m.tier, "euphemism");
  assert.equal(m.pattern, "大丈夫です");
});

test("matchApproval: negated and conditional phrases are not approvals", () => {
  assert.equal(matchApproval("This is not approved yet."), null);
  assert.equal(matchApproval("I cannot approve this in its current state."), null);
  assert.equal(matchApproval("修正いただければ承認します"), null); // promised, not given
  // ...but "〜しますから" is a reason, not a question or a condition
  assert.equal(matchApproval("承認しますから進めてください")?.pattern, "承認します");
});

test("matchApproval: no pattern → null", () => {
  assert.equal(matchApproval("この内容は検討中です。来週再確認します。"), null);
  assert.equal(matchApproval("Please take another look at the diff."), null);
  assert.equal(matchApproval(""), null);
});

test("matchApproval: snippet is a ±40-char window around the hit", () => {
  const long = "あ".repeat(100) + "承認します" + "い".repeat(100);
  assert.equal(matchApproval(long)?.snippet, "あ".repeat(40) + "承認します" + "い".repeat(40));

  const atStart = "LGTM " + "b".repeat(100);
  assert.equal(matchApproval(atStart)?.snippet, "LGTM " + "b".repeat(39)); // window clamps at the text edges
});
