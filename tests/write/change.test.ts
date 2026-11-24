import { assertEquals } from "@std/assert";
import {
  changedSinceWrite,
  inverseChange,
  plansFromProposal,
  type ReviewedField,
  staleFields,
} from "../../server/write/change.ts";

const f = (over: Partial<ReviewedField>): ReviewedField => ({
  fileId: 1,
  field: "title",
  current: "Old",
  proposed: "New",
  edited: null,
  status: "changed",
  decision: "auto",
  locked: false,
  ...over,
});

Deno.test("plans write changed and added fields, never unchanged, locked or kept ones", () => {
  const plans = plansFromProposal([
    f({}),
    f({ field: "genre", current: null, proposed: ["Jazz"], status: "added" }),
    f({ field: "album", current: "A", proposed: "A", status: "unchanged" }),
    f({ field: "date", locked: true }),
    f({ field: "label", decision: "kept_current" }),
  ]);
  assertEquals(plans.get(1)!.change, { set: { title: "New", genre: ["Jazz"] }, remove: [] });
  assertEquals(plans.get(1)!.expected, { title: "Old", genre: null });
});

Deno.test("an edited value is written, even on a field that was unchanged", () => {
  const plans = plansFromProposal([
    f({ field: "album", current: "A", proposed: "A", status: "unchanged", decision: "edited", edited: "B" }),
  ]);
  assertEquals(plans.get(1)!.change.set, { album: "B" });
});

Deno.test("a file with nothing to change has no plan", () => {
  assertEquals(plansFromProposal([f({ status: "unchanged", proposed: "Old" })]).size, 0);
});

Deno.test("stale: any field being changed that no longer holds the reviewed value", () => {
  assertEquals(staleFields({ title: "Old" }, { title: "Old", genre: null }), []);
  assertEquals(staleFields({ title: "Other", genre: ["Rock"] }, { title: "Old", genre: null }), ["title", "genre"]);
});

Deno.test("inverse change restores values and removes fields that did not exist", () => {
  const change = { set: { title: "New", genre: ["Jazz"] }, remove: ["barcode" as const] };
  assertEquals(inverseChange({ title: "Old", barcode: "123" }, change), {
    set: { title: "Old", barcode: "123" },
    remove: ["genre"],
  });
});

Deno.test("changed since the write: only the fields the write touched count", () => {
  const change = { set: { title: "New" }, remove: [] };
  assertEquals(changedSinceWrite({ title: "New", album: "X" }, { title: "New", album: "Y" }, change), []);
  assertEquals(changedSinceWrite({ title: "Mine" }, { title: "New" }, change), ["title"]);
});
