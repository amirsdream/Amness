// Runs inside the desktop window (test/desktop-ui/run.ts retro-check.js): Preferences > Theme > Retro gives blue panels, cyan double frames and a yellow accent,
// and the accent swatch does not override it.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 6000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  const r = {};
  try {
    await until(() => $("#projectName").textContent !== "…");
    $("#prefsBtn").click(); r.opens = await until(() => !!$(".modal.prefs"));
    const row = (label) => $$(".pref").find((p) => p.querySelector(".pl")?.textContent === label);
    const retro = [...row("Theme").querySelectorAll(".seg button")].find((b) => b.textContent === "Retro");
    r.choice = !!retro; retro.click(); await sleep(120);
    const css = getComputedStyle(document.documentElement);
    r.retroTheme = document.documentElement.dataset.theme === "retro" && getComputedStyle(document.body).backgroundColor === "rgb(0, 0, 168)";
    r.yellowAccent = css.getPropertyValue("--accent").trim() === "#fcfc54";
    r.doubleFrame = getComputedStyle($(".modal.prefs")).borderTopStyle === "double";
    r.square = getComputedStyle($(".modal.prefs")).borderTopLeftRadius === "0px";
    $$(".modal.prefs button").find((b) => /^Apply$/.test(b.textContent))?.click(); await sleep(300);
    r.composerFrame = getComputedStyle($(".composer")).borderTopStyle === "double";
  } catch (e) { r.failedAfter = Object.keys(r).at(-1) ?? "start"; r.error = String(e); }
  return r;
})()
