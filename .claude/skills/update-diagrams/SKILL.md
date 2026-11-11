---
name: update-diagrams
description: add or change a picture in docs/diagrams/ (Excalidraw drawings that GitHub shows as SVG) so it stays readable and true to the code
---
The pictures live in `docs/diagrams/`. The `.excalidraw` file is the source; the `.svg` next to it is what GitHub shows. `docs/diagrams.md` explains each one.

## Rules that made them readable

- One question per picture, and the shape that fits it: a flow for a system, a cycle for a loop, a timeline for things in order, a gauge for a limit, a fan-out for one-to-many, a filter for checks in order, git branches for parallel work. No grids of equal boxes.
- Few boxes. Put details as short free text next to the thing they describe. Arrows carry short labels (a few words).
- Clean lines (`roughness: 0`), the monospace font (`fontFamily: 3`), text 15 px or larger, white background. Colours by meaning: blue main path, green success or on by default, yellow a decision or "only sometimes", orange or red refusals, violet models.
- The main path reads left to right or top to bottom. A return path runs through empty space, not across other parts.

## Every claim is checked against the code

A picture is documentation: read the code before you draw the order of checks, a threshold or a command. Examples of mistakes caught this way: snapshots are taken only in the chat in a git repository (not by `amness run`); the command is `amness tasks --apply <id>`, not `amness tasks apply`.

## Steps

1. Edit the `.excalidraw` file in excalidraw.com or the VS Code Excalidraw extension (or write its JSON), and save it with the same name.
2. Export the SVG with Excalidraw's own exporter (the first time: `uv run --with playwright playwright install chromium`):

   ```bash
   uv run scripts/diagrams/export.py docs/diagrams/<name>.excalidraw --png /tmp/<name>.png
   ```

3. Look at the PNG. Fix any text that overlaps a line or another text, any arrow through a box, and any text that leaves its box. Export again until it is clean.
4. Update `docs/diagrams.md` if the picture's meaning changed (write it with the `write-docs` skill), then commit the `.excalidraw`, the `.svg` and the page together.

For layout ideas, the local `excalidraw-diagram` skill (if installed) and Archify's composition rules (main path first, branches beside their owner) are good references.
