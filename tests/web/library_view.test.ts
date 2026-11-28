/** The library page's view in the URL (D75): read, written without defaults, and its breadcrumb. */
import { assertEquals } from "@std/assert";
import { ancestors, crumbs, DEFAULT_VIEW, parseView, viewSearch } from "../../web/src/library/view.ts";

Deno.test("a view round-trips through the URL, defaults left out", () => {
  assertEquals(viewSearch(DEFAULT_VIEW), "");
  assertEquals(parseView(""), DEFAULT_VIEW);
  const v = {
    root: "inbox" as const,
    folder: "New/Rips",
    status: "ready" as const,
    sort: "changes" as const,
    q: "dune",
  };
  assertEquals(viewSearch(v), "?root=inbox&folder=New%2FRips&status=ready&sort=changes&q=dune");
  assertEquals(parseView(viewSearch(v)), v);
});

Deno.test("anything unknown in the URL falls back to the default", () => {
  assertEquals(parseView("?root=elsewhere&status=bogus&sort=size&folder=/A/B/"), { ...DEFAULT_VIEW, folder: "A/B" });
  assertEquals(viewSearch({ ...DEFAULT_VIEW, q: "   " }), "", "a blank search is no search");
});

Deno.test("the breadcrumb, and the folders to open so the selected one shows", () => {
  assertEquals(crumbs({ root: "library", folder: "Soundtracks/Dune" }), [
    { label: "Library", folder: "" },
    { label: "Soundtracks", folder: "Soundtracks" },
    { label: "Dune", folder: "Soundtracks/Dune" },
  ]);
  assertEquals(crumbs({ root: "inbox", folder: "" }), [{ label: "Inbox", folder: "" }]);
  assertEquals(ancestors("A/B/C"), ["", "A", "A/B"]);
  assertEquals(ancestors(""), []);
});
