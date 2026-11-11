# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright>=1.40.0"]
# ///
"""Export the Excalidraw drawings in docs/diagrams/ to SVG (what GitHub shows) with Excalidraw's own exporter.

    uv run scripts/diagrams/export.py                       every docs/diagrams/*.excalidraw
    uv run scripts/diagrams/export.py docs/diagrams/01-system.excalidraw --png out.png

The .excalidraw file is the source: edit it in excalidraw.com or the VS Code Excalidraw extension, then run this.
First time only: uv run --with playwright playwright install chromium
It loads @excalidraw/excalidraw 0.18.0 from esm.sh in a headless browser; the fonts are embedded in the SVG.
"""
import argparse, json, sys, tempfile
from pathlib import Path

PAGE = """<!doctype html><html><head><meta charset="utf-8"><style>body{margin:0;background:#fff}#root svg{display:block}</style></head>
<body><div id="root"></div><script type="module">
import { exportToSvg } from "https://esm.sh/@excalidraw/excalidraw@0.18.0?bundle";
window.render = async (data) => {
  const svg = await exportToSvg({ elements: data.elements, appState: { ...data.appState, exportBackground: true, exportWithDarkMode: false, exportPadding: 32 }, files: data.files || {} });
  const root = document.getElementById("root"); root.innerHTML = ""; root.appendChild(svg);
  return svg.outerHTML;
};
window.ready = true;
</script></body></html>"""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="*", type=Path)
    ap.add_argument("--png", type=Path, help="also save a PNG (only with one file)")
    a = ap.parse_args()
    root = Path(__file__).resolve().parents[2]
    files = a.files or sorted((root / "docs" / "diagrams").glob("*.excalidraw"))
    from playwright.sync_api import sync_playwright
    with tempfile.TemporaryDirectory() as tmp, sync_playwright() as p:
        page_file = Path(tmp) / "export.html"; page_file.write_text(PAGE)
        b = p.chromium.launch(headless=True)
        page = b.new_page(viewport={"width": 2400, "height": 2000})
        page.goto(page_file.as_uri()); page.wait_for_function("window.ready === true", timeout=60000)
        for f in files:
            data = json.loads(f.read_text())
            svg = page.evaluate("d => window.render(d)", data)
            f.with_suffix(".svg").write_text(svg + "\n")
            if a.png:
                page.query_selector("#root svg").screenshot(path=str(a.png))
            print(f.with_suffix(".svg"))
        b.close()


if __name__ == "__main__":
    sys.exit(main())
