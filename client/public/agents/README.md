# Agent marks

The images Settings → Agents shows beside each agent it ships with. They are
the products' own marks, used to identify the product they name - the same
nominative use a launcher or an IDE makes of them. They are **not** this
project's artwork and remain the trademarks of their owners, so treat them as
vendored third-party assets when redistributing.

| File | Agent | Source | License of the file |
| --- | --- | --- | --- |
| `claude.svg` | Claude Code | [Simple Icons](https://simpleicons.org/?q=claude), slug `claude` | CC0-1.0 (the icon file); the mark is Anthropic's trademark |
| `codex.svg` | OpenAI Codex | Wikimedia Commons, *OpenAI logo 2025 (symbol)* | Public domain per Commons; the mark is OpenAI's trademark |
| `agy.png` | Antigravity | `antigravity.google/apple-touch-icon.png`, the product's own icon | Google's, used to identify the product |

`codex.svg` was edited in one way only: `fill="currentColor"` was added so the
monochrome mark follows the row's text colour instead of rendering black on a
dark theme.

An agent contributed by an extension brings its own image (`contributes.agents[].iconUrl`),
so nothing here needs to grow when a plugin adds an agent.
