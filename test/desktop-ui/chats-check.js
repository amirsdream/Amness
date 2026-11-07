// Runs inside the desktop window (test/desktop-ui/run.ts chats-check.js --chats): the conversation list is one slim line per chat, grouped by recency; hovering shows a preview; clicking opens it.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 6000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  const r = {};
  await until(() => $("#projectName").textContent !== "…");
  r.listed = await until(() => $$(".chat-row:not(.new)").length === 4);
  r.oneLineEach = $$(".chat-row").every((row) => row.getBoundingClientRect().height <= 30);
  r.groups = $$(".chat-group").map((g) => g.textContent).join(",") === "Today,Previous 7 days,Older";
  r.shortTimes = $$(".chat-row:not(.new) .ctime").map((t) => t.textContent).slice(0, 2).join(",") === "4m,3h";
  const row = $$(".chat-row:not(.new)")[1]; row.dispatchEvent(new MouseEvent("mouseenter"));
  r.preview = await until(() => !$("#sessionPreview").classList.contains("hidden") && /webhook/i.test($("#sessionPreview").textContent));
  r.previewBesideList = $("#sessionPreview").getBoundingClientRect().left >= $("#sidebar").getBoundingClientRect().right;
  row.dispatchEvent(new MouseEvent("mouseleave")); r.previewHides = $("#sessionPreview").classList.contains("hidden");
  row.click();
  r.opens = await until(() => $("#sessionTitle").textContent === "Add retry to webhook sender" && $$(".chat-row.on").some((x) => /webhook/.test(x.textContent)));
  return r;
})()
