import assert from "node:assert/strict";
import { test } from "node:test";
import { GROUP_ORDER, groupOf, menuRows, rankCommands } from "../cli/tui/complete.ts";
import { buildCommands } from "../cli/tui/commands.ts";

const cmds = buildCommands();

test("the / menu lists every command, grouped, when nothing is typed", () => {
  const items = rankCommands("", cmds);
  assert.equal(items.length, cmds.length);                           // not capped at 8 any more
  assert.ok(items.every((i) => i.group));
  const order = items.map((i) => GROUP_ORDER.indexOf(i.group as (typeof GROUP_ORDER)[number]));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));         // groups appear in the fixed order
});

test("every built-in command has a category (nothing falls into Custom by mistake)", () => {
  assert.deepEqual(cmds.filter((c) => groupOf(c.name) === "Custom").map((c) => c.name), []);
  assert.equal(groupOf("my-own-command"), "Custom");
});

test("typing filters to a flat list ranked by match, with no group headers", () => {
  const items = rankCommands("prov", cmds);
  assert.equal(items[0].label, "/provider");
  assert.ok(items.every((i) => !i.group));
});

test("/connect exists, is found by 'keys', and sits under Model & keys", () => {
  assert.equal(rankCommands("keys", cmds)[0].label, "/connect");
  assert.equal(groupOf("connect"), "Model & keys");
});

test("menuRows: a window that follows the selection, with headers, and counts of what is hidden", () => {
  const items = rankCommands("", cmds), win = 8;
  const top = menuRows(items, 0, win);
  assert.equal(top.rows.length, win);
  assert.ok("head" in top.rows[0] && top.above === 0 && top.below > 0);   // starts with the first group's title
  const end = menuRows(items, items.length - 1, win);
  assert.ok(end.below === 0 && end.above > 0);
  assert.ok(end.rows.some((r) => "item" in r && r.item === items.length - 1));  // the last command can be reached
  for (let sel = 0; sel < items.length; sel++) {                          // the selected command is always on screen, and a group title is never cut off from its first command
    const { rows } = menuRows(items, sel, win);
    assert.ok(rows.some((r) => "item" in r && r.item === sel), `selected ${sel} visible`);
    const i = rows.findIndex((r) => "item" in r && r.item === sel);
    if (i === 0 && sel > 0 && items[sel].group !== items[sel - 1].group) assert.fail(`group title missing above item ${sel}`);
  }
});

test("menuRows on a short list shows everything and no scroll hints", () => {
  const items = rankCommands("prov", cmds);
  const r = menuRows(items, 0, 12);
  assert.equal(r.above + r.below, 0);
});
