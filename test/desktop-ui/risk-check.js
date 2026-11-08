// Runs inside the desktop window (test/desktop-ui/run.ts risk-check.js): a risky command's approval shows the command and one risk panel
// (what it will do, and whether /undo can take it back), with no second copy of the warning below it.
(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  await sleep(1500);
  showDialog({ id: 9001, kind: "choice", title: "Run command", body: ["\u001b[1mrm -rf build\u001b[22m", "", "▲ Deletes build and everything in it", "↺ /undo can put back files git sees, not ignored ones (build output, caches, .env)"], question: "Run this command?",
    options: [{ label: "Yes" }, { label: "No, and tell Amness what to do instead", hint: "esc" }],
    detail: { kind: "command", cmd: "rm -rf build", risk: { what: "Deletes build and everything in it", level: "high" }, undo: { can: "partly", text: "/undo can put back files git sees, not ignored ones (build output, caches, .env)" } } });
  await sleep(300);
  const n = document.querySelectorAll(".modal .riskbox").length, dup = /Deletes build/.test(document.querySelector(".modal .dialog-term")?.textContent ?? "");
  return { oneRiskPanel: n === 1, noDuplicate: !dup, sayWhat: /Deletes build and everything in it/.test(document.querySelector(".modal .riskbox .rwhat")?.textContent ?? ""), undoLine: /\/undo can put back/.test(document.querySelector(".modal .riskbox .rundo")?.textContent ?? "") };
})()
