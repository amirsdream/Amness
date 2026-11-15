// Runs inside the desktop window (test/desktop-ui/run.ts advanced-check.js): the Advanced view opens over the chat with the eight boxes, a pause set by
// clicking a box's pause dot stops the run before the tool call, the arguments can be read in place, and Continue lets the run go on. Esc closes it.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 10000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  const click = (el) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  const r = {};
  try {
    await until(() => $("#projectName").textContent !== "…");
    await run("/mode yolo"); await sleep(200);
    await run("/advanced");
    r.opens = await until(() => !$("#advancedRoot").classList.contains("hidden") && $$(".adv-box").length === 8);
    r.boxNames = $$(".adv-box .adv-label").map((x) => x.textContent).join(" ") === "You Hooks Context Model Tools Guards Finish Answer";
    const tools = () => $$(".adv-box")[4];
    click(tools().querySelector(".adv-pause"));
    r.pauseSet = await until(() => !!tools().querySelector(".adv-pause.on"));
    await run("fix paginate");
    r.pausedBeforeCall = await until(() => !!$(".adv-paused") && /before read_file runs/.test($(".adv-paused").textContent));
    r.argsShown = /src\/paginate\.ts/.test($(".adv-edit")?.value ?? "");
    r.boxMarkedWaiting = $$(".adv-box")[4].classList.contains("paused");
    r.framesListed = $$(".adv-item").length > 2;
    click(tools().querySelector(".adv-pause")); await sleep(150); click(tools().querySelector(".adv-pause")); await sleep(150);   // always → once → off
    r.pauseCleared = !tools().querySelector(".adv-pause.on");
    click([...$$(".adv-paused button")].find((b) => b.textContent === "Continue"));
    r.goesOn = await until(() => !$(".adv-paused"));
    r.runEnds = await until(() => !$(".app").classList.contains("running") && $$(".adv-item .tt").some((x) => x.textContent === "Your message"), 15000);
    $$(".adv-item")[1]?.click(); await sleep(150);
    r.detailShows = $$(".adv-sec").length >= 1;
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    r.escCloses = await until(() => $("#advancedRoot").classList.contains("hidden"));
  } catch (e) { r.error = String((e && e.stack) || e); }
  return r;
})();
