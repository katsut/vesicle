// Conformance review CLI: evaluate a declared decision-authority rule against the live graph and print
// the compliance gaps for a human to review. The rule is AUTHORED (here, a default approval policy);
// the ENGINE evaluates it deterministically (no LLM). Gaps = the negative knowledge to confirm/correct.
//
// Usage: pnpm tsx src/cli/conformance.ts [path/to/rule.json]
//   env: STROMA_URL (default http://127.0.0.1:7687), STROMA_API_TOKEN (if the server needs auth)
//   Needs a stroma-serve with a decision graph ingested (e.g. the backlog-decision-fixture).

import { readFileSync } from "node:fs";
import { Stroma } from "../stroma.ts";
import { review, type Rule } from "../conformance.ts";

// Default: the release-approval policy — approver must be the manager of the assignee's department, as
// of the approval time; release-type only; released without approval = a gap.
const DEFAULT_RULE: Rule = {
  subject_type: "Issue",
  scope: { predicate: "issue-type", equals: "release" },
  required: {
    hops: [{ predicate: "assigned-to" }, { predicate: "member-of" }, { predicate: "manager-of", as_of: "approved-at" }],
  },
  actual: "approved-by",
  absent_when: { predicate: "status", equals: "released" },
};

async function main() {
  const rulePath = process.argv[2];
  const rule: Rule = rulePath ? (JSON.parse(readFileSync(rulePath, "utf8")) as Rule) : DEFAULT_RULE;

  const stroma = new Stroma();
  if (!(await stroma.health())) {
    console.error(`no stroma-serve at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"} — start one with the decision graph ingested.`);
    process.exit(1);
  }

  console.log(`\n▸ Conformance review — subject type "${rule.subject_type}", authority = ${rule.required.hops.map((h) => h.predicate).join(" → ")} (as-of ${rule.required.hops.find((h) => h.as_of)?.as_of ?? "now"})`);
  const r = await review(stroma, rule);

  console.log(`\n  evaluated ${r.total} · ${r.ok} OK · ${r.notApplicable} n/a · ${r.gaps.length} gap(s) (${r.open} open, ${r.resolved} reviewed)\n`);
  if (r.gaps.length === 0) {
    console.log("  ✅ no gaps — every in-scope subject is properly resolved.");
  } else {
    for (const g of r.gaps) {
      const tag = g.verdict === "ABSENT" ? "MISSING" : `WRONG:${g.kind}`;
      if (g.human) {
        console.log(`  ✓ ${g.name}  [${tag}] — reviewed: ${g.human.decision}${g.human.reviewer ? ` by ${g.human.reviewer}` : ""}${g.human.note ? ` — "${g.human.note}"` : ""}`);
      } else {
        console.log(`  ⚠ ${g.name}  [${tag}]`);
        console.log(`      ${g.why}`);
      }
    }
    if (r.open > 0) {
      console.log(`\n  ${r.open} open gap(s) to confirm or correct (human-in-the-loop):`);
      console.log(`    pnpm resolve <issue> <confirmed|waived|data-gap> "<note>"  (records a human-asserted decision)`);
      console.log(`  A confirmation/correction is where the flywheel begins — captured as human-asserted provenance.`);
    } else {
      console.log(`\n  ✅ all gaps reviewed — the human overlay is complete (each decision is human-asserted provenance, the flywheel's labelled data).`);
    }
  }
  console.log();
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
