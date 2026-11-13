// Runs inside the desktop window (test/desktop-ui/run.ts scope-check.js): Preferences shows where a setting comes from (a badge by its name), and once an
// agent setting is changed, "Save for" lets you choose this chat, this project or all projects; Apply saves it there and the badge follows.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 6000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  const r = {};
  try {
    await until(() => $("#projectName").textContent !== "…");
    $("#prefsBtn").click(); r.opens = await until(() => !!$(".modal.prefs"));
    const tab = (t) => $$(".prefs-nav button").find((b) => b.textContent.includes(t)).click();
    const row = (label) => $$(".pref").find((p) => p.querySelector(".pl")?.firstChild?.textContent === label);
    tab("Safety"); await sleep(80);
    r.noSaveForYet = !$(".prefs-foot .savefor");
    row("Independent reviewer").querySelector(".switch").click(); await sleep(80);
    const pick = $(".prefs-foot .savefor select");
    r.saveForShown = !!pick && [...pick.options].map((o) => o.textContent).join("|") === "Each where it belongs|This chat only|This project|All my projects";
    pick.value = "chat"; pick.dispatchEvent(new Event("change"));
    $$(".prefs-foot button").find((b) => b.textContent === "Apply").click();
    r.badge = await until(() => row("Independent reviewer")?.querySelector(".scope")?.textContent === "this chat");
    row("Language-server errors").querySelector(".switch").click(); await sleep(80);
    $$(".prefs-foot button").find((b) => b.textContent === "Apply").click();
    r.projectBadge = await until(() => row("Language-server errors")?.querySelector(".scope")?.textContent === "this project");
  } catch (e) { r.failedAfter = Object.keys(r).at(-1) ?? "start"; r.error = String(e); }
  return r;
})()
