// Runs inside the desktop window (test/desktop-ui/run.ts chats-check.js --chats): the conversation list is one slim line per chat, grouped by recency.
// Recent groups are open, older ones folded with a count; an open group shows 5 and "Show N more"; hovering previews; clicking opens; search shows every match.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 6000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  const header = (name) => $$(".chat-group").find((g) => g.textContent.startsWith(name));
  const rowsIn = (name) => { const out = []; for (let el = header(name)?.nextElementSibling; el && !el.classList.contains("chat-group"); el = el.nextElementSibling) out.push(el); return out; };
  const r = {};
  await until(() => $("#projectName").textContent !== "…");
  await until(() => $$(".chat-group").length >= 3);
  r.oneLineEach = $$(".chat-row").every((row) => row.getBoundingClientRect().height <= 30);
  r.recentOpenOlderFolded = $$(".chat-group").every((g) => { const name = g.textContent.replace(/\d+$/, ""); return g.classList.contains("folded") === !["Today", "Yesterday"].includes(name); });
  r.foldedShowsCount = header("Previous 30 days")?.querySelector(".gcount")?.textContent === "8" && rowsIn("Previous 30 days").length === 0;
  header("Previous 30 days").click(); await sleep(60);
  r.openShowsFiveThenMore = rowsIn("Previous 30 days").filter((x) => x.classList.contains("chat-row")).length === 5 && rowsIn("Previous 30 days").at(-1)?.textContent === "Show 3 more";
  rowsIn("Previous 30 days").at(-1).click(); await sleep(60);
  r.showMoreShowsAll = rowsIn("Previous 30 days").filter((x) => x.classList.contains("chat-row")).length === 8 && rowsIn("Previous 30 days").at(-1)?.textContent === "Show less";
  await sleep(400);
  const tok = sessionStorage.getItem("amness-token"), saved = await fetch("/api/prefs", { headers: { "x-amness-token": tok } }).then((x) => x.json());
  r.foldRemembered = saved["chats:Previous 30 days"] === false;
  // hover and open (the newest conversation, wherever its group is)
  const first = $$(".chat-row:not(.new)")[0]; first.dispatchEvent(new MouseEvent("mouseenter"));
  r.preview = await until(() => !$("#sessionPreview").classList.contains("hidden") && /invoice/i.test($("#sessionPreview").textContent));
  r.previewBesideList = $("#sessionPreview").getBoundingClientRect().left >= $("#sidebar").getBoundingClientRect().right;
  first.dispatchEvent(new MouseEvent("mouseleave")); r.previewHides = $("#sessionPreview").classList.contains("hidden");
  first.click();
  r.opens = await until(() => $("#sessionTitle").textContent === "Fix flaky invoice export test" && $$(".chat-row.on").some((x) => /invoice/.test(x.textContent)));
  // a search shows every match, folded or not
  const q = $("#sessionSearch"); q.value = "Older task"; q.dispatchEvent(new Event("input"));
  r.searchShowsAll = await until(() => $$(".chat-row:not(.new)").length === 8 && !$(".chat-group.folded"));
  return r;
})()
