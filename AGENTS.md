# Bonjourr Development Guide

Bonjourr is a minimalist and customizable "new tab" browser extension.

1. Use **Deno** as its runtime and task runner. Never user `npm` or others. If **Deno** fails at something, stop and ask for help.
2. Do not try to add dependencies, find a native solution.
3. Repeat yourself instead of writing difficult or unreadable code.
4. Run `deno task check` after finishing changes. It runs format, lint, type check, and tests in one go. No need in-between edits.
