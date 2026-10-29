// A plain-text scan of a plugin's source for what it can touch. This is a heads-up for the approval prompt, NOT a sandbox: a plugin still runs with your full permissions,
// and a determined plugin can hide what it does. Its job is to make the ordinary case visible ("this plugin runs shell commands and uses the network").
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { projectPluginFiles } from "./plugins.ts";

export type Capability = { id: string; label: string };
const CHECKS: { id: string; label: string; re: RegExp }[] = [
  { id: "shell", label: "runs shell commands", re: /\bchild_process\b|\bexecSync\b|\bspawnSync\b|\bexecFile\b|\bBun\.spawn\b|\bDeno\.Command\b/ },
  { id: "network", label: "uses the network", re: /\bfetch\s*\(|node:(https?|net|dgram|tls)\b|\bWebSocket\b|\bXMLHttpRequest\b/ },
  { id: "files-write", label: "writes files", re: /\b(writeFile|writeFileSync|appendFile|appendFileSync|rmSync|unlinkSync|rename(Sync)?|mkdirSync|createWriteStream)\b/ },
  { id: "files-read", label: "reads files", re: /\b(readFile|readFileSync|readdirSync|createReadStream)\b/ },
  { id: "env", label: "reads environment variables (may include keys)", re: /\bprocess\.env\b/ },
  { id: "dynamic-code", label: "runs generated code (eval, new Function, dynamic import)", re: /\beval\s*\(|new Function\s*\(|\bimport\s*\(\s*(?!["'`][^"'`]*["'`]\s*\))/ },
  { id: "home", label: "looks outside the project (home folder, absolute paths)", re: /\bhomedir\s*\(|["'`]\/(etc|Users|home|root)\b|~\// },
];
export function scanSource(source: string): Capability[] { const code = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, ""); return CHECKS.filter((c) => c.re.test(code)).map(({ id, label }) => ({ id, label })); }
export const scanFile = (file: string): Capability[] => scanSource(readFileSync(file, "utf8"));
/** What each of this project's plugin files can touch, one line per file, for the approval prompt. */
export function describeProjectPlugins(cwd: string): string[] {
  return projectPluginFiles(cwd).map((f) => { const caps = scanFile(f); return `${basename(f)}: ${caps.length ? caps.map((c) => c.label).join(", ") : "no shell, network, file or environment access found"}`; });
}
