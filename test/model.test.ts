// Unit tests for the wizard's proposed-vs-confirmed mapping diff (src/model.ts mappingCorrections):
// the correction lines that land in a wizard ReviewRecord. Pure function — no engine, no server.
//
// Run: pnpm test   (tsx --test)

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mappingCorrections } from "../src/model.ts";
import type { Mapping } from "../src/types.ts";

const proposed: Mapping = {
  entity_types: { employees: "Person", projects: "Project" },
  predicates: [
    { name: "member-of", source: "assignments", from: "Person", to: "Project", cardinality: "many", properties: ["role", "allocation"], valid_end: "end_date" },
    { name: "manager-of", source: "employees.manager_id", from: "Person", to: "Person", cardinality: "one" },
  ],
};

test("mappingCorrections: applied as proposed yields no corrections", () => {
  assert.deepEqual(mappingCorrections(proposed, structuredClone(proposed)), []);
});

test("mappingCorrections: the wizard's edits — cardinality flip, props dropped, valid-time dropped, predicate dropped", () => {
  const confirmed: Mapping = {
    entity_types: { employees: "Person", projects: "Project" },
    predicates: [
      // the exact edits the wizard UI offers: keepProps off drops ONE column, keepValid off drops the end column
      { name: "member-of", source: "assignments", from: "Person", to: "Project", cardinality: "one", properties: ["role"] },
      // manager-of dropped entirely
    ],
  };
  assert.deepEqual(mappingCorrections(proposed, confirmed), [
    "member-of: cardinality many -> one",
    "member-of: edge properties dropped (allocation)",
    "member-of: valid-time (end_date) dropped",
    "manager-of dropped",
  ]);
});

test("mappingCorrections: table retargets, drops, and additions report per table", () => {
  const confirmed: Mapping = {
    entity_types: { employees: "Employee", departments: "Department" },
    predicates: proposed.predicates,
  };
  assert.deepEqual(mappingCorrections(proposed, confirmed), [
    "table employees: Person -> Employee",
    "table projects (Project) dropped",
    "table departments added (Department)",
  ]);
});

test("mappingCorrections: a retargeted predicate and an added one report generically", () => {
  const confirmed: Mapping = {
    entity_types: proposed.entity_types,
    predicates: [
      { name: "member-of", source: "assignments", from: "Person", to: "Team", cardinality: "many", properties: ["role", "allocation"], valid_end: "end_date" },
      { name: "manager-of", source: "employees.manager_id", from: "Person", to: "Person", cardinality: "one" },
      { name: "leads", source: "projects.lead_id", from: "Person", to: "Project", cardinality: "one" },
    ],
  };
  assert.deepEqual(mappingCorrections(proposed, confirmed), [
    "member-of: Person->Project retargeted to Person->Team",
    "leads added",
  ]);
});
