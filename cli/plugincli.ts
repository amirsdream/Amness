// `amness plugin new <name>` and `amness plugin list`.
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { join, resolve } from "node:path";
import { scanSource, BUILTIN_GRADERS, gradeSessions, sessionFiles, describeProjectPlugins, checkPolicies, importPlugins, loadPlugins, pluginTemplate, projectPluginDir } from "../src/index.ts";
import { dim, green, red } from "./ui.ts";

export const PLUGIN_HELP = `usage: amness plugin <command>
  new <name>     create .amness/plugins/<name>.ts from a template (never overwrites)
  policy <traces...> --plugin <file>   replay the tool calls recorded in traces (a file, or a folder such as .amness/traces) through the plugin policies and show what each would allow, ask or deny
  grade <traces...> [--plugin <file>] [--grader a,b]   score real recorded sessions (a trace file, or a folder such as .amness/traces) with built-in or plugin graders
  add <file|https-url>   copy a plugin file into .amness/plugins/ (never overwrites) and show what it appears to touch; it still needs your approval the first time you start Amness
  list           show the plugins that load here (project plugins need --trust-project to be listed as loaded)
A plugin is a TypeScript file that runs inside Amness: guardrails, loop rules, tools, slash commands and eval variants. See docs/plugins.md.`;

export async function runPlugin(argv: string[], cwd = process.cwd()): Promise<number> {
  const [cmd, name] = argv, root = resolve(cwd);
  if (!cmd || cmd === "--help" || cmd === "-h") { console.log(PLUGIN_HELP); return cmd ? 0 : 2; }
  if (cmd === "new") {
    if (!name || !/^[\w.-]{1,40}$/.test(name)) { console.error(red("✗ ") + "give a name made of letters, numbers, . _ - (for example: amness plugin new house-rules)"); return 2; }
    const file = join(projectPluginDir(root), `${name}.ts`);
    if (existsSync(file)) { console.error(red("✗ ") + `${file} already exists`); return 1; }
    mkdirSync(projectPluginDir(root), { recursive: true }); writeFileSync(file, pluginTemplate(name));
    console.log(green("created ") + file + "\n" + dim("Start the chat: it will ask you to approve this project plugin. Edit it, then /reload-plugins.")); return 0;
  }
  if (cmd === "list") {
    const r = await loadPlugins(root, { trustProject: argv.includes("--trust-project") });
    for (const p of r.plugins) console.log(`${p.name.padEnd(24)} ${p.description ?? ""}`);
    for (const w of r.warnings) console.error(red("! ") + w);
    if (r.untrusted) { console.log(dim(`${r.untrusted.count} project plugin file(s) not loaded (not approved); add --trust-project to load them here. What they appear to touch (a text scan, not a guarantee):`)); for (const l of describeProjectPlugins(root)) console.log("  " + l); }
    if (!r.plugins.length && !r.untrusted) console.log("no plugins");
    return 0;
  }
  if (cmd === "add") {
    if (!name) { console.error(red("✗ ") + "usage: amness plugin add <file or https URL>"); return 2; }
    let text: string, base: string;
    try {
      if (/^https:\/\//.test(name)) { const r = await fetch(name); if (!r.ok) throw new Error(`HTTP ${r.status}`); text = await r.text(); base = basename(new URL(name).pathname) || "plugin.ts"; }
      else if (/^http:\/\//.test(name)) { console.error(red("✗ ") + "only https URLs are accepted"); return 2; }
      else { text = readFileSync(resolve(name), "utf8"); base = basename(name); }
    } catch (e) { console.error(red("✗ ") + `could not read ${name}: ${(e as Error).message}`); return 1; }
    if (text.length > 300_000) { console.error(red("✗ ") + "that file is too large for a plugin (300 KB limit)"); return 1; }
    if (!/\bexport\s+default\b|\bexport\s*\{[^}]*\bas default\b|module\.exports/.test(text)) { console.error(red("✗ ") + "this does not look like a plugin: it has no `export default`"); return 1; }
    const file = join(projectPluginDir(root), /\.(m?[jt]s)$/.test(base) ? base : base + ".ts");
    if (existsSync(file)) { console.error(red("✗ ") + `${file} already exists`); return 1; }
    mkdirSync(projectPluginDir(root), { recursive: true }); writeFileSync(file, text);
    const caps = scanSource(text); console.log(green("added ") + file);
    console.log(caps.length ? "It appears to: " + caps.map((c) => c.label).join("; ") : "It shows no shell, network, file or environment access (a text scan, not a guarantee).");
    console.log(dim("Read it before you trust it. Amness asks for your approval the first time it starts in this project.")); return 0;
  }
  if (cmd === "grade") {
    const rest = argv.slice(1), take = (f: string) => { const i = rest.indexOf(f); return i >= 0 ? rest.splice(i, 2)[1] : undefined; };
    const pluginFiles = (take("--plugin") ?? "").split(",").filter(Boolean), pick = (take("--grader") ?? "").split(",").filter(Boolean), inputs = rest.length ? rest : [join(root, ".amness", "traces")];
    const graders: Record<string, import("../src/index.ts").Grader> = { ...BUILTIN_GRADERS };
    for (const f of pluginFiles) { const r = await importPlugins(f); for (const w of r.warnings) console.error(red("! ") + w); for (const p of r.plugins) Object.assign(graders, p.graders ?? {}); }
    const chosen = pick.length ? Object.fromEntries(pick.map((n) => { if (!graders[n]) throw new Error(`unknown grader "${n}". Known: ${Object.keys(graders).join(", ")}`); return [n, graders[n]]; })) : graders;
    const files = sessionFiles(inputs); if (!files.length) { console.error(red("✗ ") + "no trace files found"); return 2; }
    const reports = await gradeSessions(files, chosen);
    console.log(`${files.length} session file(s)`); for (const r of reports) { console.log(`${r.grader.padEnd(18)} mean ${Number.isNaN(r.mean) ? "n/a" : (r.mean * 100).toFixed(0) + "%"}  over ${r.sessions} session(s)`); for (const l of r.low) console.log(dim(`   ${(l.score * 100).toFixed(0).padStart(3)}%  ${l.session}  ${l.task.slice(0, 60)}${l.note ? "  - " + l.note : ""}`)); }
    return 0;
  }
  if (cmd === "policy") {
    const rest = argv.slice(1), pi = rest.indexOf("--plugin"), pluginFiles = pi >= 0 ? (rest.splice(pi, 2)[1] ?? "").split(",").filter(Boolean) : [], inputs = rest;
    if (!pluginFiles.length || !inputs.length) { console.error(red("✗ ") + "usage: amness plugin policy <trace file or folder>... --plugin <file>"); return 2; }
    const plugins = []; for (const f of pluginFiles) { const r = await importPlugins(f); for (const w of r.warnings) console.error(red("! ") + w); plugins.push(...r.plugins); }
    if (!plugins.some((p) => p.policy)) { console.error(red("✗ ") + "none of these plugins defines a policy"); return 2; }
    const files = inputs.flatMap((p) => (existsSync(p) && statSync(p).isDirectory() ? readdirSync(p).filter((f) => f.endsWith(".jsonl")).map((f) => join(p, f)) : [p]));
    const tally = { allow: 0, ask: 0, deny: 0, none: 0 }, shown: string[] = [];
    for (const f of files) for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.includes('"tool_calls"')) continue;
      let ev: any; try { ev = JSON.parse(line); } catch { continue; }
      for (const c of ev.message?.tool_calls ?? []) {
        let args: Record<string, unknown> = {}; try { args = JSON.parse(c.function.arguments || "{}"); } catch { /* keep empty */ }
        const d = await checkPolicies(plugins, { tool: c.function.name, args, cwd: root }); tally[d?.action ?? "none"]++;
        if (d && d.action !== "allow" && shown.length < 25) shown.push(`${d.action.padEnd(5)} ${c.function.name} ${JSON.stringify(args).slice(0, 90)}  ${dim(d.reason ?? "")}`);
      }
    }
    console.log(`${files.length} trace file(s): ${tally.deny} denied, ${tally.ask} would ask, ${tally.allow} allowed by the policy, ${tally.none} without an opinion`);
    for (const s of shown) console.log("  " + s);
    if (!shown.length) console.log(dim("  nothing was denied or asked"));
    return 0;
  }
  console.error(PLUGIN_HELP); return 2;
}
