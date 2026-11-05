// Runs inside a 1100×720 desktop window (test/desktop-ui/run.ts narrow-check.js --size 1100x720): the panel must be a drawer and nothing may scroll sideways.
(async () => { const $ = (s) => document.querySelector(s), sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while ($("#projectName").textContent === "…") await sleep(50);
  const i = $("#input"); i.value = "Fix paginate."; i.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  for (let k = 0; k < 300 && !$(".work"); k++) await sleep(50); await sleep(300);
  const r = { panelClosedAtStart: !$("#app").classList.contains("panel-open") };
  $("#togglePanel").click(); await sleep(250);
  const p = $("#panel").getBoundingClientRect(); r.panelIsDrawer = getComputedStyle($("#panel")).position === "fixed" && p.right <= innerWidth + 1;
  r.chatKeepsWidth = Math.round($("#main").getBoundingClientRect().width); r.noHorizontalScroll = document.documentElement.scrollWidth <= innerWidth;
  return r; })()
