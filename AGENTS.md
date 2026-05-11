# Bonjourr Development Guide

Bonjourr is a minimalist and customizable "new tab" browser extension.

1. Use **Deno** as its runtime and task runner. Never user `npm` or others. If **Deno** fails at something, stop and ask for help.
2. Do not try to add dependencies, find a native solution.
3. Repeat yourself instead of writing difficult or unreadable code.
4. Run `deno task check` after finishing changes. It runs format, lint, type check, and tests in one go. No need in-between edits.

如果是一些简单的编辑任务，你可以让我的另外一个 agent 来执行
下面是一个样例，你可以这样调用它。

~/Documents/Bonjourr master 7s ❯ claude -p "你好" --dangerously-skip-permissions
你好！有什么可以帮你的吗？我看到你在 Bonjourr 项目的工作目录里，这是一个浏览器新标签页扩展项目。需要我帮你做什么？
