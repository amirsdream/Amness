import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { add, cronLines, load, mergeCrontab, remove, validCron } from "../src/index.ts";

test("cron validation accepts normal expressions and rejects the rest with a reason", () => {
  for (const ok of ["0 3 * * 1-5", "*/15 * * * *", "0 0 1,15 * *", "30 6 * * 0"]) assert.equal(validCron(ok), undefined, ok);
  for (const bad of ["0 3 * *", "61 * * * *", "* 24 * * *", "*/0 * * * *", "5-2 * * * *", "a b c d e", "@daily"]) assert.ok(validCron(bad), bad);
});
test("add, replace, list and remove persist to .amness/schedules.json", () => {
  const d = mkdtempSync(join(tmpdir(), "amness-sch-"));
  add(d, { name: "nightly", cron: "0 3 * * *", task: "update deps", verify: "npm test" }); add(d, { name: "nightly", cron: "0 4 * * *", task: "update deps" });
  assert.equal(load(d).length, 1); assert.equal(load(d)[0].cron, "0 4 * * *"); assert.ok(readFileSync(join(d, ".amness", "schedules.json"), "utf8").includes("nightly"));
  assert.throws(() => add(d, { name: "x", cron: "nope", task: "t" }), /5 fields/); assert.throws(() => add(d, { name: "bad name!", cron: "* * * * *", task: "t" }), /name/);
  assert.equal(remove(d, "nightly"), true); assert.equal(remove(d, "nightly"), false);
});
test("crontab lines quote the task safely, and the marked block is replaced or removed without touching other lines", () => {
  const lines = cronLines("/work/my proj", [{ name: "n", cron: "0 3 * * *", task: "fix it; rm -rf / # it's \"odd\"", verify: "npm test" }]);
  assert.match(lines[0], /^0 3 \* \* \* cd '\/work\/my proj' && amness run --json --verify 'npm test' 'fix it; rm -rf \/ # it'\\''s "odd"'/);
  const user = "MAILTO=me\n0 1 * * * backup\n", one = mergeCrontab(user, "/p", ["* * * * * a"]), two = mergeCrontab(one, "/p", ["0 0 * * * b"]);
  assert.ok(one.startsWith(user)); assert.ok(two.includes("0 0 * * * b") && !two.includes("* * * * * a")); assert.equal(mergeCrontab(two, "/p", []), user);
  assert.ok(mergeCrontab(two, "/other", ["1 1 * * * c"]).includes("0 0 * * * b"));
});
