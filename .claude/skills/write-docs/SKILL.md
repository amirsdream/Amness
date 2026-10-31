---
name: write-docs
description: write or edit pages in docs/ and the README to the project's plain-English (CEFR B1) style
---
Read `docs/writing-guide.md` first; it is the source of truth. The short version:

- Sentences of 20 words or fewer, common words, active voice, address the reader as "you". Explain each technical term once.
- Page shape: one-line summary, "In this page you will learn" (2 to 4 bullets), sections named after what the reader wants to do, then "Next steps".
- Each feature: What it is, Why you would use it, How to use it (numbered, copy-pasteable commands), Example, Limits and common problems, Related pages.
- Be honest: mark each claim as tested, measured, or not measured yet. Remove anything you cannot confirm in the code or tests.
- Keep names, flags, paths and settings exactly as in the code, in `code font`. Do not rename headings other pages link to; if you must, fix the links.
- Check that every command you show works, and run `npm run typecheck` if you touched an example.
