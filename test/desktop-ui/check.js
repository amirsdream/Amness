// The checks run inside the desktop window by test/desktop-ui/run.ts: each key is one behaviour a person relies on (true = works).
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (f, ms = 6000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  const $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const r = {};
  const input = $("#input");
  const type = (text) => { input.focus(); input.value = text; input.setSelectionRange(text.length, text.length); input.dispatchEvent(new Event("input", { bubbles: true })); };
  const key = (k, o = {}) => input.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, ...o }));
  r.connected = await until(() => $("#projectName").textContent !== "…");
  // slash completion: the terminal's own suggestions
  type("/sta"); r.slashMenu = await until(() => $$("#mentionMenu .opt").some((o) => o.textContent.includes("/status")));
  key("Escape"); type("");
  // a command prints coloured output into the conversation
  type("/status"); key("Enter");
  r.rawBlock = await until(() => $(".rawout .tl span[style]") !== null);
  // a turn: while it runs the newest step is open and older ones fold to one line
  type("fix paginate"); key("Enter");
  let sawLiveFold = false, sawLatestOpen = false;
  const watch = setInterval(() => { const steps = $$(".step.in-timeline"); if (steps.length >= 2) { if (steps.slice(0, -1).every((s) => !s.classList.contains("open"))) sawLiveFold = true; if (steps.at(-1).classList.contains("open")) sawLatestOpen = true; } }, 20);
  r.approval = await until(() => $(".modal .choice") !== null);
  r.approvalHasDiff = !!$(".modal .diff .row.add");
  $(".modal .choice").click();
  r.turnDone = await until(() => $(".work") && !$(".step.in-timeline"), 8000);
  clearInterval(watch); r.liveOlderStepsFolded = sawLiveFold; r.liveLatestStepOpen = sawLatestOpen;
  // a finished turn: its work is one line, the answer stays in full, the changed file is a chip
  r.workFolded = !!$(".work:not(.open)") && !$(".work .timeline");
  r.workSummary = $(".work-head")?.textContent.replace(/\s+/g, " ").trim();
  r.fileChip = !!$(".work-files .file-chip");
  r.answerVisible = $$(".msg.assistant").some((m) => /off-by-one/.test(m.textContent));
  $(".work-head").click(); await sleep(120);
  r.workOpens = !!$(".work.open .timeline .step");
  const edit = $$(".timeline .tool-head").find((b) => b.textContent.includes("Edit")); const before = $$(".timeline .tool-body").length; edit?.click(); await sleep(120);
  r.stepToggles = $$(".timeline .tool-body").length !== before;
  // the panel: tiles on top, sections that fold
  r.tiles = $$(".panel .tile").length === 4;
  r.loopPanel = await until(() => $(".loop .tl") !== null);
  r.panelSections = $$(".psec-head .t").map((x) => x.textContent);
  const sess = $$(".psec-head").find((b) => b.textContent.includes("Session")), wasFolded = sess?.closest(".psec").classList.contains("folded"); sess?.click(); await sleep(60);
  r.sectionFolds = $$(".psec-head").find((b) => b.textContent.includes("Session"))?.closest(".psec").classList.contains("folded") !== wasFolded;
  // the model menu runs /model as the terminal's own picker dialog
  $("#modelBtn").click(); await sleep(100);
  const pop = $$(".popover .opt").find((o) => o.textContent.startsWith("Change model")); r.modelMenu = !!pop; pop?.click();
  r.pickerDialog = await until(() => $(".modal .pick-list .opt") !== null);
  // choose another model the way a mouse does: hover it, pass over its neighbour, come back, click. The items must survive the hover.
  const opts = $$(".modal .pick-list .opt"), target = opts.find((o) => !/gpt-6\.1-sol|Other/.test(o.textContent)), other = opts.find((o) => o !== target);
  const wanted = target?.querySelector(".lab")?.textContent;
  for (const el of [target, other, target]) el?.dispatchEvent(new MouseEvent("mouseenter"));
  r.hoverKeepsItems = !!target?.isConnected && target.classList.contains("on");
  target?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); target?.dispatchEvent(new MouseEvent("mouseup", { bubbles: true })); target?.click();
  r.pickerClosed = await until(() => !$(".modal"));
  const tok = sessionStorage.getItem("amness-token");
  r.modelChanged = await until(() => $("#modelName").textContent === wanted) && (await fetch("/api/state", { headers: { "x-amness-token": tok } }).then((x) => x.json())).model === wanted;
  // command palette lists all commands
  $("#paletteBtn").click(); r.palette = await until(() => $$(".modal .pick-list .opt").length > 50); document.querySelector(".modal input")?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await sleep(100);
  // a file link in the reply opens the file view with the changed line marked
  const link = $(".msg.assistant .filelink"); r.fileLink = !!link; link?.click(); r.viewer = await until(() => $(".code-view .ln") !== null);
  r.changedLine = !!$(".code-view .ln.changed");
  return r;
})()
