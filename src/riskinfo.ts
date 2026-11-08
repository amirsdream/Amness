// What a risky shell command will do, in one plain sentence, for the approval prompt in the terminal and the desktop app:
// "Deletes build and everything in it", "Force-pushes main to origin, replacing the commits there". The short category words of riskOf
// ("recursive/forced delete") stay as they are for the model, the policy log and the rules.
import { riskOf } from "./code.ts";
import { irreversibleReason } from "./snapshot.ts";

export type CommandRisk = {
  /** What the command will do, as one sentence. */
  what: string;
  /** high: deletes, rewrites history, runs downloaded code, acts as administrator; caution: installs packages, connects elsewhere. */
  level: "high" | "caution";
  /** Why /undo cannot take it back (it reaches beyond the working tree), when that is so. */
  irreversible?: string;
};

const ops = (args: string[]) => args.filter((a) => a && !a.startsWith("-"));
const some = (xs: string[], n = 3) => (xs.length <= n ? xs.join(", ") : `${xs.slice(0, n).join(", ")} and ${xs.length - n} more`);
const strip = (s: string) => s.replace(/^["']|["']$/g, "");
/** The words after `head` in the first part of `cmd` that contains it (parts split at && || ; and pipes). */
const after = (cmd: string, head: RegExp): string[] | undefined => {
  for (const part of cmd.split(/&&|\|\||;|\|/)) { const m = head.exec(part); if (m) return part.slice(m.index + m[0].length).trim().split(/\s+/).filter(Boolean).map(strip); }
  return undefined;
};
const host = (s: string) => { try { return new URL(s).host; } catch { return s; } };

/** The plain description of a risky command, or undefined when it is not risky. */
export function explainCommand(cmd: string): CommandRisk | undefined {
  const risk = riskOf(cmd), irreversible = irreversibleReason(cmd);
  if (!risk && !irreversible) return undefined;
  const r = (what: string, level: CommandRisk["level"] = "high"): CommandRisk => ({ what, level, ...(irreversible && { irreversible }) });
  let a: string[] | undefined;
  if (/(curl|wget)[^|;]*\|\s*(sudo\s+)?(ba|z)?sh/.test(cmd)) { const url = /https?:\/\/\S+/.exec(cmd)?.[0]; return r(`Downloads a script${url ? ` from ${host(url)}` : ""} and runs it at once, without showing it to you first`); }
  if (risk === "decodes or downloads a payload and runs it") return r("Decodes or downloads code and runs it at once");
  if ((a = after(cmd, /\bsudo\s+/))) return r(`Runs ${a.slice(0, 4).join(" ") || "a command"} as administrator (sudo)`);
  if ((a = after(cmd, /\brm\s+/))) {
    const t = ops(a), rec = a.some((x) => /^-\w*r|^--recursive$/i.test(x));
    return r(`Deletes ${t.length ? some(t) : "files"}${rec ? (t.length === 1 ? " and everything in it" : " and everything in them") : ""}`);
  }
  if ((a = after(cmd, /\bgit\s+push\b/))) {
    const force = a.some((x) => /^(-f|--force|--force-with-lease)/.test(x)), [remote, ...refs] = ops(a), ref = refs.join(" ");
    return force ? r(`Force-pushes ${ref || "the current branch"} to ${remote ?? "the remote"}, replacing the commits there`) : r(`Pushes ${ref || "the current branch"} to ${remote ?? "the remote"}`, "caution");
  }
  if ((a = after(cmd, /\bgit\s+reset\s+--hard\b/))) return r(`Moves the branch to ${ops(a)[0] ?? "the last commit"} and throws away all uncommitted changes`);
  if ((a = after(cmd, /\bgit\s+clean\b/))) return r(`Deletes untracked files${a.some((x) => /^-\w*x/.test(x)) ? ", and ignored ones too (build output, caches, .env)" : ""}${a.some((x) => /^-\w*d/.test(x)) ? ", folders included" : ""}`);
  if ((a = after(cmd, /\bgit\s+checkout\s+--/))) return r(`Throws away uncommitted changes in ${some(ops(a)) || "the named files"}`);
  if ((a = after(cmd, /\bgit\s+branch\s+-D\b/))) return r(`Deletes the branch ${some(ops(a)) || "named"}, even if it was not merged`);
  if ((a = after(cmd, /\bgit\s+rebase\b/))) return r(`Rewrites git history: replays this branch's commits${ops(a)[0] ? ` onto ${ops(a)[0]}` : ""}`);
  if ((a = after(cmd, /\b(npm|pnpm|yarn)\s+publish\b/))) return r("Publishes this package to the registry, for everyone");
  if (after(cmd, /\b(npm|pnpm|yarn)\s+login\b/)) return r("Logs in to the package registry", "caution");
  if ((a = after(cmd, /\b(pip3?|npm|pnpm|yarn|brew|apt(-get)?|cargo)\s+(install|add|i)\b/))) { const p = ops(a); return r(`Installs ${p.length ? some(p) : "the project's dependencies"} from the internet (install scripts can run code)`, "caution"); }
  if ((a = after(cmd, /\b(chmod|chown)\s+-R\b/))) { const t = ops(a); const where = t.at(-1); return r(`Changes the ${/chown/.test(cmd) ? "owner" : "permissions"} of everything ${!where || where === "." || where === "./" ? "in this folder" : `under ${where}`}`); }
  if (/:\(\)\s*\{/.test(cmd)) return r("Starts processes until the machine stops responding (a fork bomb)");
  if (/\bdd\s+if=|\bmkfs|>\s*\/dev\//.test(cmd)) return r("Writes straight to a disk or device");
  if ((a = after(cmd, /\b(ssh|scp|rsync)\s+/))) { const h = ops(a).find((x) => /@|:/.test(x)) ?? ops(a)[0]; return r(`Connects to ${h ? h.replace(/:.*$/, "") : "another machine"}`, "caution"); }
  if (irreversible && !risk) return r(irreversible.replace(/^./, (c) => c.toUpperCase()));
  return r(String(risk).replace(/^./, (c) => c.toUpperCase()));
}
