import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Event } from "./harness.ts";

/**
 * Live view of a run in the browser: file diffs as they land, tool timeline, token meter.
 * Serves on 127.0.0.1 only and rejects foreign Host headers (DNS-rebinding guard). Events are rendered with textContent,
 * never as HTML, because diffs contain untrusted file contents.
 */
export async function startLive(o: { port?: number; title?: string } = {}) {
  const history: string[] = [], clients = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host !== "127.0.0.1" && host !== "localhost") { res.writeHead(403).end("forbidden"); return; }
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      history.forEach((d) => res.write(`data: ${d}\n\n`));
      clients.add(res); req.on("close", () => clients.delete(res));
    } else if (req.url === "/" || req.url?.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'" });
      res.end(PAGE.replace("__TITLE__", (o.title ?? "Amness live").replace(/[<>&"]/g, "")));
    } else res.writeHead(404).end();
  });
  await new Promise<void>((ok, fail) => { server.once("error", fail); server.listen(o.port ?? 0, "127.0.0.1", ok); });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    onEvent(e: Event & { agent?: string }) {
      const d = JSON.stringify({ ...e, t: Date.now(), ...("diff" in e && { diff: e.diff.slice(0, 30_000) }), ...("result" in e && { result: e.result.slice(0, 400) }) });
      history.push(d); if (history.length > 1000) history.shift();
      clients.forEach((c) => c.write(`data: ${d}\n\n`));
    },
    close: () => new Promise<void>((ok) => { clients.forEach((c) => c.end()); server.close(() => ok()); server.closeAllConnections?.(); }),
  };
}

const PAGE = `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>__TITLE__</title>
<style>
:root{--bg:#0f1115;--fg:#e6e8ee;--mut:#8b93a7;--card:#171a21;--bd:#262b36;--add:#1f6f43;--addfg:#8ff0b3;--del:#7a2630;--delfg:#ffb3bd;--hunk:#7aa2ff;--acc:#7aa2ff}
@media(prefers-color-scheme:light){:root{--bg:#f6f7f9;--fg:#1b1f27;--mut:#667085;--card:#fff;--bd:#e3e6ec;--add:#d6f5e1;--addfg:#0b5d2a;--del:#fde0e3;--delfg:#8a1c2b;--hunk:#2a55c5;--acc:#2a55c5}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
header{display:flex;gap:16px;align-items:center;padding:10px 16px;border-bottom:1px solid var(--bd);position:sticky;top:0;background:var(--bg)}
header b{font-size:15px}.dot{width:9px;height:9px;border-radius:50%;background:#e5a50a}.dot.on{background:#2ea043}.dot.off{background:#6e7681}
.m{color:var(--mut)}main{display:grid;grid-template-columns:minmax(260px,32%) 1fr;gap:12px;padding:12px 16px}
@media(max-width:800px){main{grid-template-columns:1fr}}
.col{display:flex;flex-direction:column;gap:8px;min-width:0}h2{font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:var(--mut);margin:4px 0}
.ev{padding:6px 10px;border:1px solid var(--bd);border-radius:8px;background:var(--card);word-break:break-word}.ev.bad{border-color:#b4414c}.ev.warn{border-color:#b08800}
.ev small{color:var(--mut)}.f{border:1px solid var(--bd);border-radius:10px;background:var(--card);overflow:hidden}
.f>div{padding:8px 12px;font-weight:600;display:flex;gap:10px;align-items:center;border-bottom:1px solid var(--bd);position:sticky;top:48px;background:var(--card)}
pre{margin:0;padding:6px 0;overflow:auto;font:12.5px/1.5 ui-monospace,Menlo,monospace}pre span{display:block;padding:0 12px;white-space:pre}
.a{background:var(--add);color:var(--addfg)}.d{background:var(--del);color:var(--delfg)}.h{color:var(--hunk)}.c{color:var(--mut)}
label{margin-left:auto;display:flex;gap:6px;align-items:center}
</style>
<header><span class="dot" id=dot></span><b>__TITLE__</b><span class=m id=stat>waiting for events…</span><label class=m><input type=checkbox id=follow checked>follow</label></header>
<main><div class=col><h2>Timeline</h2><div class=col id=tl></div></div><div class=col><h2>Changes</h2><div class=col id=files><span class=m>No edits yet.</span></div></div></main>
<script>
const $=id=>document.getElementById(id),tl=$("tl"),files=$("files");let steps=0,tokens=0,edits=0,cards={};
const el=(t,c,x)=>{const e=document.createElement(t);if(c)e.className=c;if(x!=null)e.textContent=x;return e};
function ev(text,cls,sub){const e=el("div","ev "+(cls||""),text);if(sub){e.append(el("br"),el("small",0,sub))}tl.append(e);return e}
function card(p){if(cards[p])return cards[p];if(files.firstChild&&!files.firstChild.className)files.textContent="";const f=el("div","f"),h=el("div",0,p),s=el("span","m","");h.append(s);f.append(h);const pre=el("pre");f.append(pre);files.append(f);return cards[p]={f,s,pre,a:0,r:0}}
function on(e){
 const who=e.agent&&e.agent!=="lead"?"["+e.agent+"] ":"";
 if(e.kind==="turn"){steps=e.step+1;tokens=e.tokens}
 else if(e.kind==="tool"){const bad=/^(ERROR|DENIED|REJECTED|exit=[^0])/.test(e.result);let a="";try{const j=JSON.parse(e.args);a=j.cmd||j.path||j.query||j.url||j.description||""}catch{}ev(who+e.name+" "+String(a).slice(0,90),bad?"bad":"",bad?e.result.slice(0,140):"")}
 else if(e.kind==="edit"){edits++;const c=card(e.path);c.a+=e.added;c.r+=e.removed;c.s.textContent=(e.created?"new  ":"")+"+"+c.a+" −"+c.r;
  const sep=el("span","c","── edit "+edits+" ──");c.pre.append(sep);
  for(const l of e.diff.split("\\n")){if(/^(---|\\+\\+\\+)/.test(l))continue;c.pre.append(el("span",l[0]==="+"?"a":l[0]==="-"?"d":l[0]==="@"?"h":"",l))}
  ev("✎ "+e.path,"","+"+e.added+" −"+e.removed)}
 else if(e.kind==="rollover")ev("⟳ context rolled over","warn",e.detail);
 else if(e.kind==="finish"){ev("✔ finished","",e.summary);$("dot").className="dot off"}
 else if(e.detail)ev(e.kind+": "+e.detail.slice(0,160),["denied","budget","rejected"].includes(e.kind)?"bad":"warn");
 $("stat").textContent=steps+" turns · "+tokens.toLocaleString()+" tokens · "+edits+" edits";
 if($("follow").checked)scrollTo(0,document.body.scrollHeight)}
const es=new EventSource("/events");es.onopen=()=>$("dot").className="dot on";es.onerror=()=>$("dot").className="dot";es.onmessage=m=>on(JSON.parse(m.data));
</script>`;
