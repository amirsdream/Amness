// Runs inside the desktop window for `npm run test:desktop-ui`: edit an earlier message in place and resend it; switch a harness guard in Preferences; edit the todo list.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)), $ = (s) => document.querySelector(s), $$ = (s) => [...document.querySelectorAll(s)];
  const until = async (f, ms = 8000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) return false; await sleep(40); } return true; };
  const tok = sessionStorage.getItem("amness-token"), get = (p) => fetch(p, { headers: { "x-amness-token": tok } }).then((x) => x.json());
  const r = {};
  await until(() => $("#projectName").textContent !== "…");
  const input = $("#input"); input.value = "fix paginate"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await until(() => $(".modal .choice")); $(".modal .choice").click();
  await until(() => $$(".msg.assistant").some((m) => /off-by-one/.test(m.textContent)) && $("#status").classList.contains("hidden"));
  // edit the message in place
  const editBtn = $(".msg.user .msg-edit"); r.editButton = !!editBtn; editBtn?.click();
  r.editorOpens = await until(() => $(".edit-area")?.value === "fix paginate");
  $(".edit-area").value = "only explain paginate, change nothing";
  $$(".edit-row .btn").find((b) => /Save/.test(b.textContent)).click();
  r.resent = await until(() => $$(".msg.user .bubble").some((b) => /only explain paginate/.test(b.textContent)) && !$$(".msg.user .bubble").some((b) => b.textContent === "fix paginate"), 10000);
  await until(() => $("#status").classList.contains("hidden"));
  r.oneTurnNow = (await get("/api/state")).session.turns === 1;
  // Preferences → Harness: switch the repeated-call guard off
  $("#prefsBtn").click(); await until(() => !!$(".modal.prefs"));
  $$(".prefs-nav button").find((b) => b.textContent.includes("Harness")).click(); await sleep(80);
  const loopRow = $$(".pref").find((p) => p.querySelector(".pl")?.textContent === "Repeated-call guard"); r.harnessTab = !!loopRow;
  loopRow?.querySelector(".switch").click(); await sleep(600);
  r.guardOff = (await get("/api/settings")).harness.guards.find((g) => g.name === "loop").on === false;
  $(".modal.prefs .icon-btn").click(); await sleep(60);
  // the todo list in its editor
  input.value = "/todos edit"; input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  r.todoEditor = await until(() => !!$("textarea.long-edit"));
  $("textarea.long-edit").value = "- [x] read paginate\n- [~] explain it"; $$(".modal footer .btn").find((b) => b.textContent === "Save").click();
  r.todosInPanel = await until(() => $$(".panel .todo").length === 2 && /explain it/.test($(".panel .todo.doing")?.textContent ?? ""));
  return r;
})()
