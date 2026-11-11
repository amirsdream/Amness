// `amness doctor [model]`: run the qualification battery (src/doctor.ts) on a model and, with --write, put the result in its profile.
import { join, resolve } from "node:path";
import { formatDoctor, runDoctor, writeProfile, type DoctorReport } from "../src/index.ts";
import type { Config } from "./config.ts";
import { createModel } from "./model.ts";
import { detectWindow } from "./models.ts";
import { guessTier, resolveConfig } from "./roles.ts";

export const DOCTOR_HELP = `amness doctor [model] [--write] [--yes] [--json]
  Checks how a model uses tools before you give it a job: one typed call, two calls in one reply, a chain of three,
  tool_choice "required", calls written as text, recovery after an error, the stated window, and prefix-cache latency.
  About ten short requests (a few thousand tokens). The model is a reference: an id, provider:model, or server:<name>[/model];
  default: the main model.
  --write   save the suggested settings and the verdict in .amness/profile.json (the model's own entry)
  --yes     do not ask before calling a paid provider
  --json    print the report as JSON`;

export async function runDoctorCli(argv: string[], deps: { cfg: Config; confirm: (q: string) => Promise<boolean>; version: string; cwd?: string }): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) { console.log(DOCTOR_HELP); return 0; }
  const ref = argv.find((a) => !a.startsWith("--"));
  let r; try { r = resolveConfig(ref ?? deps.cfg.model, deps.cfg); } catch (e) { console.error((e as Error).message); return 2; }
  const local = guessTier(r.config) === "local";
  if (!local && !argv.includes("--yes") && !(await deps.confirm(`This sends about ten short requests (a few thousand tokens) to ${r.label}. Continue?`))) return 1;
  const stated = await detectWindow({ provider: r.config.provider, baseUrl: r.config.baseUrl, apiKey: r.config.apiKey, model: r.config.model }).catch(() => undefined);
  const json = argv.includes("--json");
  let rep: DoctorReport;
  try { rep = await runDoctor(createModel(r.config), { stated, onCheck: json ? undefined : (c) => console.error(`${c.pass ? "✓" : "✗"} ${c.title}`) }); }
  catch (e) { console.error(`doctor failed: ${(e as Error).message}`); return 1; }
  console.log(json ? JSON.stringify({ model: r.label, ...rep }) : "\n" + formatDoctor(r.label, rep));
  if (argv.includes("--write")) {
    const file = resolve(deps.cwd ?? ".", join(".amness", "profile.json")), at = new Date().toISOString().slice(0, 10);
    writeProfile(file, r.config.model, { ...rep.suggest, qualified: { roles: rep.qualified, at, by: `amness doctor ${deps.version}` } }, `checked with amness doctor on ${at}`);
    if (!json) console.log(`\nwrote ${r.config.model} in ${file}`);
  } else if (!json) console.log("\nadd --write to save this in .amness/profile.json");
  return rep.qualified.includes("main") ? 0 : 1;
}
