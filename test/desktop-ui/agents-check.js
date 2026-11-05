// Runs inside the desktop window for test/desktop-ui/agents.ts.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 10000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  await until(() => $("#projectName").textContent !== "…");
  const input = $("#input"); input.value = "explore auth, routes and tests"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  const r = {};
  r.liveCard = await until(() => $$(".tool.agents .agent-row").length === 3);
  r.liveHead = $(".agents-head")?.textContent;
  r.thinkingLiveInChat = await until(() => [...document.querySelectorAll(".thinking.live")].some((t) => t.open && /Splitting/.test(t.textContent)));
  r.noThinkingAboveComposer = !$("#statusThink") && !/Splitting/.test($("#status").textContent);
  r.thinkingFoldsWhenNextPartStarts = await until(() => $$(".thinking").some((t) => !t.classList.contains("live") && !t.open && /Thought for/.test(t.textContent)));
  r.separateTaskCards = $$(".tool:not(.agents):not(.group)").filter((t) => /Agent/.test(t.textContent)).length;
  await until(() => $(".agents-head") && /done/.test($(".agents-head").textContent) && !/working/.test($(".agents-head").textContent), 15000);
  await until(() => $(".msg.assistant") && $("#status").classList.contains("hidden"), 8000); await sleep(300);
  r.doneHead = $(".agents-head")?.textContent;
  r.thinkingOnlyInsideWork = $$(".thinking").every((t) => t.closest(".work"));
  $(".work-head")?.click(); await sleep(150);                                      // the finished turn's work is folded: open it, then a row
  r.thinkingFoldedInWork = $$(".work .timeline .thinking").length >= 1 && $$(".work .timeline .thinking").every((t) => !t.open);
  $$(".agent-line")[0].click(); await sleep(200);
  r.rowOpens = !!$(".agent-row .kids .kid");
  r.panelHasNoAgentsDup = !$$(".psec-head .t").some((x) => /Agents/.test(x.textContent));
  return r;
})()
