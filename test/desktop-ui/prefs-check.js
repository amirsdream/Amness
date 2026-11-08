// Runs inside the desktop window for `npm run test:desktop-ui`: Preferences previews the window at once, every change waits for Apply (agent settings then run the App's own commands),
// Revert and a discarded close undo the preview, drafts survive tab switches, and what was applied is saved.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 6000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  const tok = sessionStorage.getItem("amness-token"), get = (p) => fetch(p, { headers: { "x-amness-token": tok } }).then((r) => r.json());
  const r = {};
  await until(() => $("#projectName").textContent !== "…");
  r.titleMark = $("img.logo")?.complete && $("img.logo").naturalWidth > 0;
  $("#prefsBtn").click(); r.opens = await until(() => !!$(".modal.prefs"));
  const row = (label) => $$(".pref").find((p) => p.querySelector(".pl")?.textContent === label);
  // appearance
  row("Theme").querySelectorAll(".seg button")[2].click(); await sleep(80); r.lightTheme = document.documentElement.dataset.theme === "light" && getComputedStyle(document.body).backgroundColor === "rgb(247, 248, 250)";
  row("Accent colour").querySelector('[title="teal"]').click(); await sleep(50); r.accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#0f8f83";
  const size = row("Chat text size").querySelector("input[type=range]"); size.value = "16"; size.dispatchEvent(new Event("input")); await sleep(50);
  r.chatSize = getComputedStyle(document.documentElement).getPropertyValue("--chat-size").trim() === "16px";
  row("Density").querySelectorAll(".seg button")[1].click(); await sleep(50); r.compact = document.body.classList.contains("compact");
  // chat behaviour: no folding
  $$(".prefs-nav button").find((b) => b.textContent.includes("Chat")).click(); await sleep(50);
  row("Fold finished turns").querySelector(".switch").click(); await sleep(50);
  // agent settings are drafts: nothing reaches the App before Apply
  const tab = (name) => $$(".prefs-nav button").find((b) => b.textContent.includes(name));
  tab("Safety").click(); await sleep(50);
  row("Language-server errors").querySelector(".switch").click();
  const sb = row("Sandbox").querySelector("select"); sb.value = "workspace"; sb.dispatchEvent(new Event("change"));
  await sleep(300);
  let st = await get("/api/settings"); r.notBeforeApply = st.lsp === false && st.sandbox === "off";
  r.footerCounts = /7 changes not applied yet/.test($(".prefs-foot").textContent) && row("Sandbox").classList.contains("changed");
  // leave the tab and come back: the drafts are still there, and the tab is marked
  tab("Appearance").click(); await sleep(80); tab("Safety").click(); await sleep(80);
  r.backShowsDrafts = row("Sandbox").querySelector("select").value === "workspace" && row("Language-server errors").querySelector(".switch").classList.contains("on") && tab("Safety").classList.contains("dirty");
  // Apply runs them through the App's own commands, quietly
  [...$$(".prefs-foot button")].find((b) => b.textContent === "Apply").click();
  r.applied = await until(() => /No changes/.test($(".prefs-foot").textContent)) && await (async () => { st = await get("/api/settings"); return st.lsp === true && st.sandbox === "workspace"; })();
  r.noTranscriptNoise = !$(".rawout");
  // Revert undoes a live preview
  tab("Appearance").click(); await sleep(50);
  row("Accent colour").querySelector('[title="pink"]').click(); await sleep(50);
  const pinkShown = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() !== "#0f8f83";
  [...$$(".prefs-foot button")].find((b) => b.textContent === "Revert").click(); await sleep(80);
  r.revertUndoesPreview = pinkShown && getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() === "#0f8f83" && /No changes/.test($(".prefs-foot").textContent);
  // closing with a change asks first; Discard puts it back
  row("Density").querySelectorAll(".seg button")[0].click(); await sleep(50);
  $(".modal.prefs .icon-btn").click(); await sleep(80);
  r.closeAsks = !!$(".modal.prefs") && /Apply your 1 change before closing\?/.test($(".prefs-foot").textContent);
  [...$$(".prefs-foot button")].find((b) => b.textContent === "Discard").click(); await sleep(80);
  r.discardRestores = !$(".modal.prefs") && document.body.classList.contains("compact");
  // a folder outside the project, from the new Folders and trust tab
  $("#prefsBtn").click(); await until(() => !!$(".modal.prefs"));
  tab("Folders").click(); await sleep(80);
  const add = row("Folders outside this project").querySelector(".addrow input"); add.value = "/tmp"; add.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await sleep(80);
  r.listDraft = row("Folders outside this project").querySelector(".pli.added")?.textContent.includes("/tmp");
  [...$$(".prefs-foot button")].find((b) => b.textContent === "Apply").click();
  r.folderApplied = await until(() => /No changes/.test($(".prefs-foot").textContent)) && !!row("Folders outside this project").querySelector(".pli:not(.added):not(.addrow)")?.textContent.includes("tmp");
  r.trustedListed = !!row("Trusted folders");
  tab("About").click(); await sleep(80); r.aboutIcon = $(".about img")?.naturalWidth > 0;
  $(".modal.prefs .icon-btn").click(); await sleep(50); r.closesWhenClean = !$(".modal.prefs");
  // a finished turn now stays unfolded
  const input = $("#input"); input.value = "fix paginate"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => $(".modal .choice")); $(".modal .choice").click();
  await until(() => $$(".msg.assistant").some((m) => /off-by-one/.test(m.textContent)) && $("#status").classList.contains("hidden"), 8000); await sleep(200);
  r.noFoldWhenOff = !$(".work") && !!$(".step");
  await sleep(400); const saved = await get("/api/prefs");
  r.saved = saved.theme === "light" && saved.accent === "teal" && saved.chatSize === 16 && saved.density === "compact" && saved.foldFinished === false;
  return r;
})()
