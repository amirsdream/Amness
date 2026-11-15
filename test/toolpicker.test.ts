import { test } from "node:test";
import assert from "node:assert/strict";
import { groupTools, picksFrom, totals, ToolPickerOverlay, type PickGroup } from "../cli/tui/toolpicker.ts";
import { strip } from "../cli/tui/text.ts";

const tool = (name: string, def: "on" | "demand" = "on", tokens = 50) => ({ name, description: `${name} does a thing.`, tokens, state: def, def });
const groups = () => groupTools([tool("read_file"), tool("grep"), tool("sh"), tool("finish"), tool("gh__list", "demand", 120), tool("gh__create", "demand", 200), tool("lint_check")], { mcp: (n) => (n.includes("__") ? n.split("__")[0] : undefined), plugin: (n) => (n === "lint_check" ? "house-rules" : undefined) });

test("tool picker groups: built-in kinds, each MCP server, each plugin; finish is never listed", () => {
  const g = groups();
  assert.deepEqual(g.map((x) => x.label), ["Read and search", "Shell", "MCP · gh", "Plugin · house-rules"]);
  assert.ok(!g.flatMap((x) => x.tools).some((t) => t.name === "finish"));
});

test("saving: only what differs from the default; a whole MCP server in one state is one pattern; choices for servers not connected now are kept", () => {
  const g = groups();
  assert.deepEqual(picksFrom(g, { grep: "off", gh__list: "on", gh__create: "on" }), { on: ["gh__*"], off: ["grep"] });
  assert.deepEqual(picksFrom(g, { gh__list: "off" }), { off: ["gh__list"] }, "one tool of a server");
  assert.deepEqual(picksFrom(g, {}, { off: ["jira__*", "old_tool"], demand: ["gh__*"] }), { off: ["jira__*", "old_tool"] }, "gh is here and back to its default; jira is not here, so its choice stays");
  const t = totals(g, { sh: "off", gh__list: "on" }); assert.deepEqual(t, { on: 4, demand: 1, off: 1, tokens: 50 + 50 + 120 + 50 }, "read_file, grep, gh__list and lint_check are on");
});

test("the terminal window: Space switches a tool on → on demand → off, a group all at once; typing filters; Enter returns the states", () => {
  let got: unknown; const o = new ToolPickerOverlay(groups() as PickGroup[], (r) => { got = r; });
  const text = () => strip(o.render(100, 30).lines.join("\n"));
  assert.match(text(), /Read and search\s+2\/2 on/); assert.match(text(), /MCP · gh\s+0\/2 on/);
  o.key({ name: "char", text: "g" }); o.key({ name: "char", text: "r" }); o.key({ name: "char", text: "e" }); assert.match(text(), /filter: gre[\s\S]*grep/); assert.doesNotMatch(text(), /read_file/);
  o.key({ name: "down" }); o.key({ name: "char", text: " " }); o.key({ name: "char", text: " " }); assert.match(text(), /○ grep/);
  o.key({ name: "escape" }); assert.doesNotMatch(text(), /filter: gre/, "Esc clears the filter first");
  const gh = o.rows().findIndex((r) => !r.t && r.g.label === "MCP · gh"); o.sel = gh; o.key({ name: "char", text: " " });
  assert.match(text(), /MCP · gh\s+0\/2 on/, "both were on demand: one press switches the group to off");
  o.key({ name: "enter" }); assert.deepEqual(got, { states: { grep: "off", gh__list: "off", gh__create: "off" } });
});
