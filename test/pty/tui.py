#!/usr/bin/env python3
"""Drives the real TUI through a pseudo-terminal against a mock OpenAI-compatible server.  Run: python3 test/pty/tui.py"""
import codecs, fcntl, json, os, pty, re, select, struct, sys, tempfile, termios, threading, time
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ANSI = re.compile(r"\x1b\[[0-9;?]*[A-Za-z]")
DOWN, ENTER, ESC, CTRL_C, CTRL_D, TAB = "\x1b[B", "\r", "\x1b", "\x03", "\x04", "\t"

class Mock:
    """replies: list of (delay_seconds, assistant_message). Served in order."""
    def __init__(self, replies, luna=False):
        self.replies, self.requests, self.paths, self.luna = list(replies), [], [], luna
        outer = self
        class H(BaseHTTPRequestHandler):
            def log_message(self, *a): pass
            def do_POST(self):
                try: self._post()
                except (BrokenPipeError, ConnectionResetError): pass       # the client (a test hitting Esc/Ctrl-C) hung up mid-stream
            def _post(self):
                body = json.loads(self.rfile.read(int(self.headers["content-length"])))
                outer.paths.append(self.path)
                if outer.luna and self.path.endswith("/chat/completions") and body.get("tools"):     # what OpenAI really answers for GPT-5.4+ reasoning models
                    data = json.dumps({"error": {"message": "Function tools with reasoning_effort are not supported for gpt-5.6-luna in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to none.", "type": "invalid_request_error", "param": "reasoning_effort", "code": "unsupported_parameter"}}).encode()
                    self.send_response(400); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data); return
                outer.requests.append(body)
                if self.path.endswith("/responses"):
                    delay, msg = outer.replies.pop(0) if outer.replies else (0, {"role": "assistant", "content": "done"})
                    time.sleep(delay)
                    text = msg.get("content") or ""
                    out = [{"id": "rs_1", "type": "reasoning", "summary": [], "encrypted_content": "ENC-" + str(len(outer.requests))}]
                    if text: out.append({"id": "msg_1", "type": "message", "role": "assistant", "status": "completed", "content": [{"type": "output_text", "text": text, "annotations": []}]})
                    for c in msg.get("tool_calls") or []: out.append({"id": "fc_" + c["id"], "type": "function_call", "call_id": c["id"], "name": c["function"]["name"], "arguments": c["function"]["arguments"]})
                    resp = {"id": "resp_%d" % len(outer.requests), "status": "completed", "output": out, "usage": {"input_tokens": 900, "output_tokens": 100, "total_tokens": 1000, "input_tokens_details": {"cached_tokens": 600}, "output_tokens_details": {"reasoning_tokens": 60}}}
                    self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
                    def ev(o): self.wfile.write(("event: " + o["type"] + "\ndata: " + json.dumps(o) + "\n\n").encode()); self.wfile.flush()
                    ev({"type": "response.created", "response": {"id": resp["id"]}})
                    ev({"type": "response.reasoning_summary_text.delta", "delta": "Considering the request. "}); time.sleep(0.05)
                    for i in range(0, len(text), 7): ev({"type": "response.output_text.delta", "delta": text[i:i + 7]}); time.sleep(0.01)
                    for i, it in enumerate(out): ev({"type": "response.output_item.done", "output_index": i, "item": it})
                    ev({"type": "response.completed", "response": resp}); return
                delay, msg = outer.replies.pop(0) if outer.replies else (0, {"role": "assistant", "content": "done"})
                time.sleep(delay)
                usage = {"prompt_tokens": 40, "completion_tokens": 10, "total_tokens": 50}
                try:
                    if body.get("stream"):                       # real SSE, like OpenAI: text in pieces, tool calls as argument fragments
                        self.send_response(200); self.send_header("content-type", "text/event-stream"); self.end_headers()
                        def ev(o): self.wfile.write(("data: " + json.dumps(o) + "\n\n").encode()); self.wfile.flush()
                        text = msg.get("content") or ""
                        for i in range(0, len(text), 7): ev({"choices": [{"delta": {"content": text[i:i + 7]}}]}); time.sleep(0.01)
                        for idx, c in enumerate(msg.get("tool_calls") or []):
                            a = c["function"]["arguments"]
                            ev({"choices": [{"delta": {"tool_calls": [{"index": idx, "id": c["id"], "function": {"name": c["function"]["name"], "arguments": a[:5]}}]}}]})
                            ev({"choices": [{"delta": {"tool_calls": [{"index": idx, "function": {"arguments": a[5:]}}]}}]})
                        ev({"choices": [], "usage": usage}); self.wfile.write(b"data: [DONE]\n\n"); self.wfile.flush()
                    else:
                        data = json.dumps({"choices": [{"message": msg}], "usage": usage}).encode()
                        self.send_response(200); self.send_header("content-type", "application/json"); self.send_header("content-length", str(len(data))); self.end_headers(); self.wfile.write(data)
                except (BrokenPipeError, ConnectionResetError): pass
        self.srv = HTTPServer(("127.0.0.1", 0), H); self.url = f"http://127.0.0.1:{self.srv.server_port}/v1"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

def tc(name, args, i=[0]):
    i[0] += 1
    return {"role": "assistant", "content": None, "tool_calls": [{"id": f"c{i[0]}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}

class PyVT:
    """Just enough VT100 to replay what the TUI writes: cursor moves, erase, scrolling, wide chars."""
    def __init__(self, cols, rows): self.cols, self.rows = cols, rows; self.grid = [[" "] * cols for _ in range(rows)]; self.scroll = []; self.r = self.c = 0; self.pend = ""
    def _lf(self):
        if self.r == self.rows - 1: self.scroll.append("".join(self.grid.pop(0)).rstrip()); self.grid.append([" "] * self.cols)
        else: self.r += 1
    def feed(self, data):
        s = self.pend + data; self.pend = ""; i = 0
        while i < len(s):
            ch = s[i]
            if ch == "\x1b" and s[i + 1:i + 2] == "]":
                j = re.search(r"\x07|\x1b\\", s[i:])
                if not j: self.pend = s[i:]; return
                i += j.end(); continue
            if ch == "\x1b":
                m = re.match(r"\x1b\[([0-9;?]*)([A-Za-z])", s[i:])
                if not m:
                    if len(s) - i < 12: self.pend = s[i:]; return
                    i += 1; continue
                i += m.end(); arg, fin = m.group(1), m.group(2)
                if arg.startswith("?"): continue
                n = int(arg.split(";")[0] or 0)
                if fin == "A": self.r = max(0, self.r - (n or 1))
                elif fin == "B": self.r = min(self.rows - 1, self.r + (n or 1))
                elif fin == "C": self.c = min(self.cols - 1, self.c + (n or 1))
                elif fin == "G": self.c = max(0, min(self.cols - 1, (n or 1) - 1))
                elif fin == "J":
                    if n == 2: self.grid = [[" "] * self.cols for _ in range(self.rows)]
                    else:
                        for x in range(self.c, self.cols): self.grid[self.r][x] = " "
                        for y in range(self.r + 1, self.rows): self.grid[y] = [" "] * self.cols
                elif fin == "K":
                    for x in range(0 if n == 2 else self.c, self.cols): self.grid[self.r][x] = " "
                elif fin == "H": self.r, self.c = max(0, (n or 1) - 1), 0
                continue
            i += 1
            if ch == "\r": self.c = 0
            elif ch == "\n": self._lf()
            elif ch < " ": pass
            else:
                import unicodedata
                w = 2 if unicodedata.east_asian_width(ch) in "WF" else (0 if unicodedata.combining(ch) else 1)
                if self.c + w > self.cols: self.c = 0; self._lf()
                self.grid[self.r][self.c] = ch
                if w == 2 and self.c + 1 < self.cols: self.grid[self.r][self.c + 1] = ""
                self.c = min(self.cols - 1, self.c + w)
    def lines(self):
        rows = ["".join(r).rstrip() for r in self.grid]
        while rows and not rows[-1]: rows.pop()
        return self.scroll + rows

class Term:
    def __init__(self, args, mock, cwd=None, proj=None, model="m"):
        self.home = tempfile.mkdtemp()
        cwd = cwd or tempfile.mkdtemp()            # never run an agent inside the repo under test
        json.dump({"lastDir": proj or cwd, "verifyByDir": {}, "tasks": ["an old task"]}, open(os.path.join(self.home, "state.json"), "w"))
        json.dump({"provider": "custom", "baseUrl": mock.url, "model": model, "maxTokens": 100000}, open(os.path.join(self.home, "config.json"), "w"))
        env = dict(os.environ, AMNESS_HOME=self.home, TERM="xterm-256color"); env.pop("NO_COLOR", None); env.pop("OPENAI_API_KEY", None)
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            os.chdir(cwd); os.execvpe("node", ["node", "--no-warnings", os.path.join(ROOT, "cli/amness.ts")] + args, env)
        fcntl.ioctl(self.fd, termios.TIOCSWINSZ, struct.pack("HHHH", 45, 100, 0, 0))
        self.buf = ""; self.vt = PyVT(100, 45); self.dec = codecs.getincrementaldecoder("utf-8")(errors="replace")
    def pump(self, t=0.1):
        r, _, _ = select.select([self.fd], [], [], t)
        if r:
            try: chunk = self.dec.decode(os.read(self.fd, 65536))
            except OSError: return False
            self.buf += chunk; self.vt.feed(chunk)
        return True
    def text(self): return ANSI.sub("", self.buf).replace("\r", "")
    def screen(self): self.pump(0.05); return "\n".join(self.vt.lines())
    def wait(self, pat, timeout=15, since=0):
        end = time.time() + timeout
        while time.time() < end:
            if re.search(pat, self.text()[since:]): return True
            if not self.pump(): break
        return bool(re.search(pat, self.text()[since:]))
    def send(self, s): os.write(self.fd, s.encode()); self.pump(0.15)
    def mark(self): return len(self.text())
    def exited(self, timeout=5):
        end = time.time() + timeout
        while time.time() < end:
            p, st = os.waitpid(self.pid, os.WNOHANG)
            if p: return os.WEXITSTATUS(st) if os.WIFEXITED(st) else -1
            self.pump(0.1)
        return None

results = []
def check(name, cond, term=None):
    results.append((name, bool(cond)))
    print(("  ok   " if cond else "  FAIL ") + name)
    if not cond and term: print("----- terminal -----\n" + term.text()[-1800:] + "\n--------------------")

def scenario_menu_filter_and_esc():
    print("menu: filter + esc-cancel")
    t = Term(["menu"], Mock([]))
    check("menu renders", t.wait(r"What do you want to do\?") and t.wait(r"Memory\s+see, add"), t)
    t.send("/"); t.send("mem")
    check("filter narrows the list", t.wait(r"/mem") , t)
    m = t.mark(); t.send(ENTER)
    check("opens Memory screen", t.wait(r"Project directory", since=m), t)
    m = t.mark(); t.send(ESC)
    check("Esc cancels the prompt and returns to the menu", t.wait(r"cancelled", since=m) and t.wait(r"What do you want to do\?", since=m), t)
    t.send(ESC); check("Esc at the menu quits cleanly", t.exited() == 0, t)

def scenario_paste_plan_run(proj):
    print("code agent: multi-line paste, plan card, live diff, follow-up menu")
    mock = Mock([(0, tc("write_file", {"path": "hello.txt", "content": "hi there\n"})), (0, tc("finish", {"summary": "created hello.txt"}))])
    t = Term(["menu"], mock, proj=proj)
    t.wait(r"What do you want to do\?"); t.send(ENTER)                         # Code agent (first item)
    check("remembers last project", t.wait(re.escape(proj)), t)
    check("asks for the task first", t.wait(r"What should the agent do"), t)
    t.send("create hello.txt\nsaying hi there\nthanks" + ENTER)                 # one write == a paste
    check("paste becomes ONE task: plan card shows its first line, nothing leaked", t.wait(r"Ready to run") and t.wait(r"task\s+create hello\.txt…"), t)
    check("plan card lists directory and verify", t.wait(r"directory\s+" + re.escape(proj)) and t.wait(r"verify\s+none"), t)
    m = t.mark(); t.send(ENTER)                                                 # ▶ Start
    check("live diff streams while it runs", t.wait(r"✎ hello\.txt .*\+1", since=m) and t.wait(r"\+hi there", since=m), t)
    check("summary + next-steps menu", t.wait(r"Done") and t.wait(r"What next\?") and t.wait(r"Review changes \(1 edit\)") and t.wait(r"Follow up"), t)
    check("file really written", open(os.path.join(proj, "hello.txt")).read() == "hi there\n")
    check("finished run leaves no stale checkpoint", not os.path.exists(os.path.join(proj, ".amness/checkpoint.json")))
    check("task text reached the model intact", "saying hi there" in json.dumps(mock.requests[0]["messages"][1]["content"]) and "thanks" in mock.requests[0]["messages"][1]["content"])
    st = json.load(open(os.path.join(t.home, "state.json")))
    check("task + project remembered for next time", st["tasks"][0].startswith("create hello.txt") and st["lastDir"] == proj)
    m = t.mark(); t.send(ESC); t.wait(r"What do you want to do\?", since=m); t.send(ESC)
    check("exits cleanly", t.exited() == 0, t)

def scenario_ctrl_c(proj):
    print("code agent: Ctrl-C stops safely and keeps progress")
    mock = Mock([(0, tc("list_files", {})), (4, tc("finish", {"summary": "too late"}))])
    t = Term(["menu"], mock, proj=proj)
    t.wait(r"What do you want to do\?"); t.send(ENTER); t.wait(r"What should the agent do")
    t.send("look around" + ENTER); t.wait(r"Ready to run"); t.send(ENTER)
    check("run started", t.wait(r"list_files"), t)
    time.sleep(0.5); m = t.mark(); t.send(CTRL_C)
    check("Ctrl-C announces a safe stop (does not kill the app)", t.wait(r"stopping after the current step", since=m), t)
    check("run ends as Interrupted with progress saved", t.wait(r"Interrupted · progress saved", timeout=12), t)
    check("app is still alive at the next-steps menu", t.wait(r"What next\?"), t)
    cp = os.path.join(proj, ".amness/checkpoint.json")
    check("checkpoint kept for resuming", os.path.exists(cp) and len(json.load(open(cp))) >= 4)
    m = t.mark(); t.send(ESC); t.wait(r"What do you want to do\?", since=m); t.send(ESC)
    check("exits cleanly afterwards", t.exited() == 0, t)

def scenario_resume_and_card(proj):
    print("code agent: interrupted run is offered, resume continues with a new instruction")
    mock = Mock([(0, tc("finish", {"summary": "resumed and finished"}))])
    t = Term(["menu"], mock, proj=proj)
    t.wait(r"What do you want to do\?"); t.send(ENTER); t.wait(r"What should the agent do")
    t.send("also add a license" + ENTER)
    check("plan card offers the interrupted run", t.wait(r"interrupted\s+will continue where it stopped"), t)
    m = t.mark(); t.send(ENTER)
    check("resumed run finishes", t.wait(r"resumed and finished", since=m) and t.wait(r"What next\?", since=m), t)
    check("new instruction was added as a follow-up", mock.requests[0]["messages"][-1]["content"] == "also add a license", t)
    check("checkpoint cleared after finishing", not os.path.exists(os.path.join(proj, ".amness/checkpoint.json")))
    m = t.mark(); t.send(ESC); t.wait(r"What do you want to do\?", since=m); t.send(ESC); t.exited()


def say(text): return {"role": "assistant", "content": text}

def scenario_chat_basic_and_edit():
    print("chat TUI: streaming reply, tool call, edit approval with diff, exit")
    proj = tempfile.mkdtemp(); open(os.path.join(proj, "notes.txt"), "w").write("alpha\nbeta\n")
    mock = Mock([(0, say("Sure thing.\n\nHere is **the plan**: read the file, then change `beta`.")),
                 (0, tc("read_file", {"path": "notes.txt"})), (0, tc("edit_file", {"path": "notes.txt", "old": "beta", "new": "BETA"})), (0, say("All set."))])
    t = Term([], mock, cwd=proj)
    check("welcome card and pinned input box appear", t.wait(r"welcome") and t.wait(r"\? for shortcuts") and t.wait(r"❯"), t)
    t.send("hello there" + ENTER)
    check("reply streams in with markdown rendered", t.wait(r"● Sure thing\.") and t.wait(r"the plan: read the file, then change beta\."), t)
    check("user message is echoed once into scrollback (real screen, not raw bytes)", t.screen().count("❯ hello there") == 1, t)
    t.send("now change beta to uppercase" + ENTER)
    check("permission prompt shows the diff", t.wait(r"Apply this change\?") and t.wait(r"- beta") and t.wait(r"\+ BETA"), t)
    check("nothing written before approval", open(os.path.join(proj, "notes.txt")).read() == "alpha\nbeta\n")
    m = t.mark(); t.send(ENTER)
    check("approved edit is applied and shown as a diff", t.wait(r"● Update\(notes\.txt\)", since=m) and t.wait(r"Added 1 line, removed 1 line", since=m) and t.wait(r"All set\.", since=m), t)
    check("file changed on disk", open(os.path.join(proj, "notes.txt")).read() == "alpha\nBETA\n")
    check("request was streamed over real SSE", all(r.get("stream") for r in mock.requests))
    check("footer shows the context gauge and the model", t.wait(r"▰*▱+ [0-9]+%") and t.wait(r"◆ m"), t)
    t.send(CTRL_D)
    check("Ctrl-D exits cleanly and prints a resume hint", t.exited() == 0 and "Resume this conversation with: amness -c" in t.text(), t)

def scenario_chat_interrupt_paste_modes():
    print("chat TUI: bracketed paste, Shift+Tab, Esc interrupt, double Ctrl-C")
    proj = tempfile.mkdtemp()
    mock = Mock([(0, tc("list_files", {})), (6, say("this answer arrives too late"))])
    t = Term([], mock, cwd=proj)
    t.wait(r"\? for shortcuts")
    t.send("\x1b[200~line A\nline B\nline C\x1b[201~")
    check("pasted multi-line text lands in the box as one input", t.wait(r"line C") and "❯ line A" in t.screen() and "  line B" in t.screen(), t)
    t.send("\x1b[Z"); check("Shift+Tab switches to accept-edits (footer shows it)", t.wait(r"accept edits on"), t)
    m = t.mark(); t.send(ENTER)
    check("run starts: status line with elapsed time and tokens", t.wait(r"Working…", since=m) and t.wait(r"esc to interrupt", since=m), t)
    for _ in range(100):
        if mock.requests: break
        time.sleep(0.05)
    check("whole paste reached the model", "line A\nline B\nline C" in json.dumps(mock.requests[0]["messages"][-1]["content"]).replace("\\n", "\n"))
    time.sleep(1.0); m = t.mark(); t.send(ESC)
    check("Esc interrupts safely", t.wait(r"interrupted", since=m, timeout=10), t)
    check("app is idle again, input box usable", t.wait(r"\? for shortcuts", since=m), t)
    m = t.mark(); t.send(CTRL_C); check("Ctrl-C asks for confirmation", t.wait(r"press ctrl-c again to exit", since=m), t)
    t.send(CTRL_C); check("second Ctrl-C exits", t.exited() == 0, t)

def scenario_gpt56_luna_responses_api():
    print("chat TUI vs the reported OpenAI error: gpt-5.6-luna refuses tools on Chat Completions")
    proj = tempfile.mkdtemp(); open(os.path.join(proj, "notes.txt"), "w").write("alpha\nbeta\n")
    mock = Mock([(0, tc("read_file", {"path": "notes.txt"})), (0, say("The file has two lines."))], luna=True)
    t = Term([], mock, cwd=proj, model="gpt-5.6-luna")
    t.wait(r"\? for shortcuts")
    t.send("how many lines in notes.txt?" + ENTER)
    check("no HTTP 400 reaches the user; the answer arrives", t.wait(r"The file has two lines\.", timeout=20) and "HTTP 400" not in t.text(), t)
    check("the tool call ran and was summarised", t.wait(r"● Read\(notes\.txt\)") and t.wait(r"Read 2 lines"), t)
    check("it tried chat once, then used /v1/responses for everything after", mock.paths[0].endswith("/chat/completions") and [p.split("/")[-1] for p in mock.paths[1:]] == ["responses", "responses"], t)
    r2 = mock.requests[-1]
    kinds = [i.get("type") or i.get("role") for i in r2["input"]]
    check("reasoning + function_call are replayed with the function_call_output", kinds == ["user", "reasoning", "function_call", "function_call_output"] and r2["input"][1]["encrypted_content"].startswith("ENC-"), t)
    check("request is stateless and flat-tool shaped", r2["store"] is False and r2["tools"][0]["type"] == "function" and "function" not in r2["tools"][0] and "messages" not in r2, t)
    m = t.mark(); t.send("/status" + ENTER)
    check("/status reports the Responses API", t.wait(r"responses API", since=m), t)
    m = t.mark(); t.send("/tokens" + ENTER)
    check("/tokens shows cache hits and reasoning from the usage block", t.wait(r"prompt cache\s+[0-9]+% of input served from cache", since=m) and t.wait(r"hidden reasoning tokens", since=m), t)
    t.send(CTRL_D); t.exited()

def scenario_chat_slash_and_files():
    print("chat TUI: slash popup, @file attach, /cost, /undo")
    proj = tempfile.mkdtemp(); open(os.path.join(proj, "config.yml"), "w").write("port: 8080\n")
    mock = Mock([(0, say("Port is 8080."))])
    t = Term([], mock, cwd=proj)
    t.wait(r"\? for shortcuts")
    t.send("/co"); check("slash popup lists matching commands (aliases are searchable)", t.wait(r"/compact") and t.wait(r"/tokens +context window.*\(also /cost\)"), t)
    t.send("\x15")
    t.send("what port is in @conf"); check("@file popup lists the file", t.wait(r"config\.yml"), t)
    t.send(TAB); t.send(ENTER)
    check("reply arrives and the attachment is noted", t.wait(r"Port is 8080") and t.wait(r"attached config\.yml \(1 line\)"), t)
    check("file contents were sent to the model", "port: 8080" in json.dumps(mock.requests[0]["messages"][-1]["content"]))
    m = t.mark(); t.send("/tokens" + ENTER)
    check("/tokens prints the context gauge and usage", t.wait(r"context window", since=m) and t.wait(r"what fills it", since=m) and t.wait(r"1 request", since=m), t)
    t.send(CTRL_D); t.exited()

if __name__ == "__main__":
    scenario_gpt56_luna_responses_api(); scenario_chat_basic_and_edit(); scenario_chat_interrupt_paste_modes(); scenario_chat_slash_and_files()
    scenario_menu_filter_and_esc()
    proj = tempfile.mkdtemp(); scenario_paste_plan_run(proj)
    proj2 = tempfile.mkdtemp(); scenario_ctrl_c(proj2); scenario_resume_and_card(proj2)
    bad = [n for n, ok in results if not ok]
    print(f"\n{len(results) - len(bad)}/{len(results)} checks passed"); sys.exit(1 if bad else 0)
