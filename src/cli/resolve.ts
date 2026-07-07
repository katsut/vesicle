// Record a human decision on a conformance gap — the flywheel's first turn. The engine surfaced the
// gap; a person decides what it means (confirmed / waived / data-gap) and that decision is written back
// into the graph as human-asserted facts. Re-running the review then shows the gap as reviewed.
//
// Usage: pnpm tsx src/cli/resolve.ts <issue> <confirmed|waived|data-gap> ["note"]
//   env: STROMA_URL, STROMA_API_TOKEN, VESICLE_REVIEWER (the reviewer's name/handle; default "reviewer")

import { Stroma } from "../stroma.ts";
import { recordReview, type Decision } from "../review.ts";

const DECISIONS: Decision[] = ["confirmed", "waived", "data-gap"];

async function main() {
  const [issueArg, decisionArg, note] = process.argv.slice(2);
  const issue = Number(issueArg);
  if (!Number.isInteger(issue) || !DECISIONS.includes(decisionArg as Decision)) {
    console.error(`usage: pnpm resolve <issue-id> <${DECISIONS.join("|")}> ["note"]`);
    process.exit(2);
  }
  const reviewer = process.env.VESICLE_REVIEWER ?? "reviewer";

  const stroma = new Stroma();
  if (!(await stroma.health())) {
    console.error(`no stroma-serve at ${process.env.STROMA_URL ?? "http://127.0.0.1:7687"}`);
    process.exit(1);
  }
  await stroma.ensureAuthed();
  await recordReview(stroma, { issue, decision: decisionArg as Decision, reviewer, note });
  console.log(`✓ recorded: #${issue} → ${decisionArg}${note ? ` ("${note}")` : ""} by ${reviewer} (human-asserted)`);
  console.log(`  re-run \`pnpm conformance\` to see it as reviewed.`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
