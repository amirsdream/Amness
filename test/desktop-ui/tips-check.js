// Runs inside the desktop window (test/desktop-ui/run.ts tips-check.js): hovering a button, a menu item or a panel tile shows one styled tooltip.
// It replaces the system tooltip (the title attribute is gone), shows a shortcut as a key chip, opens beside menu items, appears at once when you move to the next button, and hides on a click.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 3000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(20); } return true; };
  const at = (el) => { const b = el.getBoundingClientRect(); return { clientX: b.left + b.width / 2, clientY: b.top + b.height / 2 }; };
  const over = (el) => el.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, ...at(el) }));
  const out = (el, to = document.body) => el.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, relatedTarget: to }));
  const tip = () => $("#tip"), shown = () => !!tip()?.classList.contains("on");
  const inView = () => { const t = tip().getBoundingClientRect(); return t.left >= 0 && t.top >= 0 && t.right <= innerWidth && t.bottom <= innerHeight; };
  // the real cursor sits somewhere in this window and redraws make Chromium send it hover events; only this script's own (untrusted) events may reach the page
  for (const t of ["pointerover", "pointerout", "pointermove", "pointerdown"]) addEventListener(t, (e) => { if (e.isTrusted) e.stopImmediatePropagation(); }, true);
  const r = {};
  try {
  await until(() => $("#modelName").textContent !== "…", 6000);

  const model = $("#modelBtn"); over(model);
  r.notAtOnce = !shown();                                                            // a quick pass over a button shows nothing
  r.shows = await until(shown) && new RegExp($("#modelName").textContent).test(tip().textContent) && /Change the model/.test(tip().textContent);
  r.systemTooltipGone = !model.hasAttribute("title") && model.getAttribute("aria-describedby") === "tip";
  r.belowButton = tip().getBoundingClientRect().top >= model.getBoundingClientRect().bottom && inView();
  out(model); r.hidesOnLeave = !shown();

  const pal = $("#paletteBtn"); over(pal);
  r.warmShowsAtOnce = shown();                                                       // the pointer just left another tip
  r.shortcutChip = tip().querySelector(".kbd")?.textContent === (/Mac/.test(navigator.platform) ? "⌘K" : "Ctrl+K") && !/\(Ctrl/.test(tip().textContent);
  pal.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true })); r.hidesOnClick = !shown();
  out(pal); await sleep(800);

  model.click(); await until(() => !!$(".popover"));
  const items = $$(".popover .opt");
  r.everyMenuItemHasTip = items.length >= 9 && items.every((x) => x.dataset.tip || x.getAttribute("title"));
  const effort = items.find((x) => /Reasoning effort/.test(x.textContent)); over(effort);
  r.menuTip = await until(shown) && /thinks before it answers/.test(tip().textContent) && tip().querySelector(".kbd") === null;
  const er = effort.getBoundingClientRect(), tr = tip().getBoundingClientRect();
  r.menuTipBeside = (tr.left >= er.right || tr.right <= er.left) && inView();        // beside the item, not over the next one
  out(effort); document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); await sleep(800);

  if (!$(".app").classList.contains("panel-open") && getComputedStyle($("#panel") ?? document.body).display === "none") $("#togglePanel").click();
  await until(() => !!$(".tile"));
  const tile = $(".tile"); over(tile);
  r.tileTip = await until(shown) && /Context window/.test(tip().querySelector(".tip-head.strong")?.textContent ?? "") && $$(".tip-line").length === 1 && inView();
  await sleep(1200); r.tileTipSurvivesRedraw = shown();                               // the panel redraws while you hover
  out(tile);

  await sleep(800); const head = $$(".psec-head").find((x) => /Changes/.test(x.textContent)); over(head);   // found after the wait: the panel redraws
  r.sectionTip = await until(shown) && /Files changed/.test(tip().textContent) && /Click to (fold|show)/.test(tip().textContent);
  out(head);
  } catch (e) { r.failedAfter = Object.keys(r).at(-1) ?? "start"; r.error = String(e); }
  return r;
})()
