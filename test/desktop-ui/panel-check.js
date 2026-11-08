// Runs inside the desktop window (test/desktop-ui/run.ts panel-check.js): the workspace panel updates in place, so what is under the pointer does not blink,
// loop lines have no tooltip of their own, and each bar of the context chart shows that request's tokens and cost on hover.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(30); } return true; };
  for (const t of ["pointerover", "pointerout", "pointermove", "pointerdown"]) addEventListener(t, (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);   // the real cursor must not interfere
  const at = (el) => { const b = el.getBoundingClientRect(); return { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }; };
  const over = (el) => el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, ...at(el) }));
  const out = (el) => el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: document.body }));
  const tip = () => $("#tip"), shown = () => !!tip()?.classList.contains("on");
  const r = {};
  try {
    await until(() => $("#projectName").textContent !== "…");
    if (getComputedStyle($("#panel")).display === "none") $("#togglePanel").click();
    const input = $("#input"); input.focus(); input.value = "fix paginate"; input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    await until(() => $$("#panel .loop .tl").length > 3);
    const tiles = $("#panel .tiles"), line = $$("#panel .loop .tl")[0], text = line.textContent;
    await sleep(500);                                                                // several redraws while it runs
    r.panelUpdatesInPlace = tiles.isConnected;
    r.unchangedLineKept = line.isConnected || $$("#panel .loop .tl")[0].textContent !== text;   // the same element, unless its own text changed
    r.loopLinesHaveNoTip = $$("#panel .loop .tl").every((x) => !x.dataset.tip && !x.hasAttribute("title"));
    await until(() => !$(".app").classList.contains("running") && $$(".spark.reqs g").length >= 5, 15000);
    const bars = $$(".spark.reqs g");
    r.barPerRequest = bars.length === sd.requests.length;                             // the scripted run makes 5 or more requests
    r.cachedPartDrawn = $$(".spark.reqs .bar.cached").length === sd.requests.filter((x) => x.cached > 0).length;
    const hit = bars[1].querySelector(".hit"); r.hoverAreaFullHeight = Math.abs(hit.getBoundingClientRect().height - $(".spark.reqs").getBoundingClientRect().height) < 1;
    over(hit);
    r.barTip = await until(shown, 2000) && /Request 2 · step 2/.test(tip().textContent) && /Sent 4\.2k tokens · (<1|\d+)% of the window/.test(tip().textContent) && /Cached 3\.1k \(74%\)/.test(tip().textContent) && /Received 180/.test(tip().textContent) && /≈ (<?\$[\d.]+)/.test(tip().textContent);
    r.tipText = tip().textContent.slice(0, 160);
    const next = bars[2].querySelector(".hit"); out(hit); over(next);
    r.nextBarAtOnce = shown() && /Request 3/.test(tip().textContent);
    await sleep(1200); r.tipSurvivesRedraw = shown() && /Request 3/.test(tip().textContent);
    out(next);
  } catch (e) { r.failedAfter = Object.keys(r).at(-1) ?? "start"; r.error = String(e); }
  return r;
})()
