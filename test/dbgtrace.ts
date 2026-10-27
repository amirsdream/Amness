import { mkdirSync, appendFileSync } from "node:fs";
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(17, 23), ...a);
log("mkdir"); try { mkdirSync("/proc/nope", { recursive: true }); log("mkdir ok?!"); } catch (e) { log("mkdir err", (e as Error).message); }
log("append"); try { appendFileSync("/proc/nope/x.jsonl", "x"); } catch (e) { log("append err", (e as Error).message); }
log("fetch"); const t0 = Date.now();
const ctl = new AbortController(); setTimeout(() => ctl.abort(), 8000);
await fetch("http://127.0.0.1:1/v1/traces", { method: "POST", body: "{}", signal: ctl.signal }).then(() => log("fetch ok?!"), (e) => log("fetch err", String(e?.cause?.code ?? e), Date.now() - t0));
log("done");
