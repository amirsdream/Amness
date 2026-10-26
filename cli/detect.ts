import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Best-guess command that proves the project works (used as the finish gate). */
export function detectVerify(dir: string): string {
  try {
    if (existsSync(join(dir, "package.json"))) {
      const t = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).scripts?.test;
      if (t && !/no test specified/.test(t)) return "npm test";
    }
  } catch { /* ignore */ }
  if (existsSync(join(dir, "Cargo.toml"))) return "cargo test";
  if (existsSync(join(dir, "go.mod"))) return "go test ./...";
  if (["pytest.ini", "pyproject.toml", "setup.py", "tox.ini"].some((f) => existsSync(join(dir, f)))) return "pytest -q";
  return "";
}
