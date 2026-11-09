// Runs inside the desktop window (test/desktop-ui/run.ts prefs-actions-check.js): a Preferences button that opens its own view (keys and servers, plugins)
// does not close Preferences. Its dialog appears above, cancelling it comes back to the same tab with the drafts kept, and printed output shows under the button.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  const tab = (n) => $$(".prefs-nav button").find((b) => b.textContent.includes(n)), row = (l) => $$(".pref").find((p) => p.querySelector(".pl")?.textContent === l);
  const esc = () => (document.activeElement ?? document).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));   // where a real key press goes, cancelable like a real one
  const r = {};
  await until(() => $("#projectName").textContent !== "…");
  $("#prefsBtn").click(); await until(() => !!$(".modal.prefs"));
  tab("Safety").click(); await sleep(80); row("Language-server errors").querySelector(".switch").click(); await sleep(50);   // a draft
  tab("Model").click(); await sleep(80);
  row("Providers, keys and servers").querySelector("button").click();
  r.dialogAbovePrefs = await until(() => !!$("#modalRoot .modal") && !!$("#prefsRoot .modal.prefs"));
  r.dialogIsTheProviders = /Providers and servers/.test($("#modalRoot").textContent);
  await until(() => !!document.activeElement?.closest?.("#modalRoot"));                // a person presses Esc once the dialog has the focus
  esc();
  r.backInPrefs = await until(() => !$("#modalRoot .modal") && !!$("#prefsRoot .modal.prefs"));
  r.sameTab = tab("Model")?.classList.contains("on");
  r.draftKept = /1 change not applied yet/.test($(".prefs-foot").textContent);
  tab("Extend").click(); await sleep(80);
  row("Plugins").querySelector("button").click();
  r.outputUnderButton = await until(() => (row("Plugins").querySelector(".pout")?.textContent ?? "").length > 3 && !/running/.test(row("Plugins").querySelector(".pout").textContent));
  r.prefsStillOpen = !!$("#prefsRoot .modal.prefs");
  r.noChatNoise = !$$(".rawout").some((x) => /plugin/i.test(x.textContent));
  esc(); await sleep(80);
  r.escAsksAboutDraft = /Apply your 1 change before closing/.test($(".prefs-foot")?.textContent ?? "");
  return r;
})()
