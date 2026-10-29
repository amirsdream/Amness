# How we write the documentation

These rules keep the docs easy to read for people whose first language is not English, and for people who are in a hurry. The target is **CEFR level B1**: clear, everyday English that most learners can read without a dictionary.

## Language

- Write short sentences. Aim for 20 words or fewer. One idea per sentence.
- Use common words. Say "use", not "utilise". Say "start", not "initiate". Say "check", not "verify" (except when `verify` is the name of a setting).
- Talk to the reader: "you can…", "you will see…". Use active voice ("Amness saves the file"), not passive ("the file is saved").
- Explain every technical word the first time you use it, in one short sentence. Example: "A *token* is a small piece of text that a model reads. One token is about four letters."
- Avoid idioms and phrasal verbs ("figure out", "kick off"). Avoid "e.g." and "i.e."; write "for example" and "that is".
- Do not chain clauses with semicolons or long dashes. Split them into two sentences.
- Keep names, commands, flags, file paths and settings exactly as they are in the code. Put them in `code font`.

## Structure of a page

1. **One-sentence summary** at the top, then "In this page you will learn" with 2 to 4 bullets.
2. **Sections named after what the reader wants to do**: "Run a task in CI", "Stop the agent from editing lockfiles". Not "Overview of the subsystem".
3. For each feature, in this order:
   - **What it is** (1 to 2 sentences).
   - **Why you would use it** (1 to 2 sentences).
   - **How to use it**: numbered steps, each with the exact command in a code block.
   - **Example**: a realistic example and what you will see.
   - **Limits and common problems**: be honest about what does not work, what is not measured, and what can go wrong.
   - **Related pages**: links.
4. End with "Next steps" (links).

## Honesty

- Say clearly when something is **tested** (automated tests), **measured** (run on a real model with results), or **not measured yet**. Do not call something "better" or "faster" without a measurement.
- If you cannot confirm a statement in the code or the tests, remove it or mark it "not verified".
- Show the limits next to the feature, not at the end of the page.

## Layout

- Use short paragraphs (1 to 4 sentences), bullet lists, and tables for options and commands.
- Every command in a code block must work if the reader copies it. Show expected output when it helps.
- Use a screenshot when it saves 100 words. Images are in `docs/images/`.
- Keep headings that other pages link to. Do not rename them without updating the links.
