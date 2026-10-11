import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { FilterPanel, FilterToggle } from "./responsive-filters";

const disclosure = {
  contentId: "filters-test",
  compact: true,
  expanded: false,
  toggle: () => {},
};

it("links the compact action to a hidden but still mounted filter panel", () => {
  const action = renderToStaticMarkup(createElement(FilterToggle, { disclosure, active: false }));
  const panel = renderToStaticMarkup(
    createElement(FilterPanel, {
      disclosure,
      children: createElement("input", { defaultValue: "retained filter" }),
    }),
  );
  expect(action).toContain('aria-controls="filters-test"');
  expect(action).toContain('aria-expanded="false"');
  expect(action).toContain('aria-label="Show filters"');
  expect(panel).toContain('id="filters-test"');
  expect(panel).toContain('hidden=""');
  expect(panel).toContain("retained filter");
});

it("has no desktop action and keeps the desktop panel visible", () => {
  const desktop = { ...disclosure, compact: false, expanded: true };
  expect(
    renderToStaticMarkup(createElement(FilterToggle, { disclosure: desktop, active: true })),
  ).toBe("");
  expect(
    renderToStaticMarkup(createElement(FilterPanel, { disclosure: desktop, children: "Filters" })),
  ).not.toContain("hidden=");
});
