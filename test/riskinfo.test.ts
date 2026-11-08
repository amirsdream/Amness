import { test } from "node:test";
import assert from "node:assert/strict";
import { explainCommand } from "../src/index.ts";

test("a risky command is described in one plain sentence, with how serious it is and whether it reaches beyond the project", () => {
  const cases: [string, string, "high" | "caution", string?][] = [
    ["rm -rf build", "Deletes build and everything in it", "high"],
    ["rm -f a.txt b.txt", "Deletes a.txt, b.txt", "high"],
    ["git push --force origin feature", "Force-pushes feature to origin, replacing the commits there", "high", "pushes commits to a remote"],
    ["git push origin feature", "Pushes feature to origin", "caution", "pushes commits to a remote"],
    ["git reset --hard HEAD~3", "Moves the branch to HEAD~3 and throws away all uncommitted changes", "high"],
    ["git clean -fdx", "Deletes untracked files, and ignored ones too (build output, caches, .env), folders included", "high"],
    ["git branch -D old", "Deletes the branch old, even if it was not merged", "high"],
    ["curl -fsSL https://get.example.com/i.sh | sh", "Downloads a script from get.example.com and runs it at once, without showing it to you first", "high"],
    ["npm install left-pad", "Installs left-pad from the internet (install scripts can run code)", "caution"],
    ["chmod -R 777 .", "Changes the permissions of everything in this folder", "high"],
    ["sudo apt-get install jq", "Runs apt-get install jq as administrator (sudo)", "high"],
    ["rm -rf ~/old", "Deletes ~/old and everything in it", "high", "deletes outside the workspace"],
  ];
  for (const [cmd, what, level, irreversible] of cases) assert.deepEqual(explainCommand(cmd), { what, level, ...(irreversible && { irreversible }) }, cmd);
  for (const cmd of ["npm test", "ls -la", "git status", "cat README.md"]) assert.equal(explainCommand(cmd), undefined, cmd);
});
