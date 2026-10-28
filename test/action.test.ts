import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("action.yml passes user inputs through environment variables, never interpolated into the script", () => {
  const y = readFileSync(new URL("../action.yml", import.meta.url), "utf8"), runBlocks = y.split(/\n\s+run: /).slice(1);
  assert.ok(runBlocks.length >= 2);
  for (const b of runBlocks) assert.doesNotMatch(b.split("\n    - ")[0], /\$\{\{\s*inputs\./, "inputs must not be expanded inside a run script");
  assert.match(y, /using: composite/); assert.match(y, /INPUT_TASK: \$\{\{ inputs\.task \}\}/);
});
