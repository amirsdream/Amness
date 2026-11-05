// Runs inside the desktop window for `npm run test:desktop-ui`: Preferences changes the window at once, agent settings reach the App (through its own commands), and everything is saved.
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
  // agent settings go through the App's own commands
  $$(".prefs-nav button").find((b) => b.textContent.includes("Safety")).click(); await sleep(50);
  row("Language-server errors").querySelector(".switch").click();
  const sb = row("Sandbox").querySelector("select"); sb.value = "workspace"; sb.dispatchEvent(new Event("change"));
  await sleep(700);                                                                // the two commands run on the server
  const st = await get("/api/settings"); r.lspOn = st.lsp === true; r.sandbox = st.sandbox;
  r.noTranscriptNoise = !$(".rawout");
  $$(".prefs-nav button").find((b) => b.textContent.includes("About")).click(); await sleep(80); r.aboutIcon = $(".about img")?.naturalWidth > 0;
  $(".modal.prefs .icon-btn").click(); await sleep(50);
  // a finished turn now stays unfolded
  const input = $("#input"); input.value = "fix paginate"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => $(".modal .choice")); $(".modal .choice").click();
  await until(() => $$(".msg.assistant").some((m) => /off-by-one/.test(m.textContent)) && $("#status").classList.contains("hidden"), 8000); await sleep(200);
  r.noFoldWhenOff = !$(".work") && !!$(".step");
  await sleep(400); const saved = await get("/api/prefs");
  r.saved = saved.theme === "light" && saved.accent === "teal" && saved.chatSize === 16 && saved.density === "compact" && saved.foldFinished === false;
  return r;
})()
