# pi-central-doc — central documentation research for Pi

A Pi extension (`pi-central-doc`) that exposes the `central_doc` tool, letting the
main model consult a central documentation hub without loading documents into its
own context, plus a `/pi-central-doc-publish` command that adapts a markdown file or session
output into that hub (frontmatter, `INDEX.md`, `systems.yaml`, glossary, validator).

When the model calls `central_doc`, the extension spawns a **separate `pi` session**
with:

- a **configurable model** (or the calling session's model by default),
- a **configurable documentation root** as its working directory,
- read-only tools (`read`, `grep`, `find`, `ls` by default),
- a documentation-specific system prompt (INDEX.md first, glossary, `related:` links, cited answers).

The child researches the question and returns one cited answer. The parent session
only gains that answer, plus a list of consulted files.

```
main session ──central_doc(question)──▶ pi subprocess (docsDir, model, read-only)
     ▲                                          │
     └────────── cited answer + sources ────────┘
```

Requirements: Pi 1.3+ and Node 22+. The hub is expected to be a git repository
with an `INDEX.md` entry point and `AGENTS.md` conventions; `/pi-central-doc-publish`
also uses `systems.yaml`, `glossary.md`, and `scripts/check-docs.py` when present
(the validator is configurable, so other layouts work too).

Files:

| File | Purpose |
|---|---|
| `index.ts` | Extension: tool, flags, `/pi-central-doc` and `/pi-central-doc-publish` commands, renderers, subprocess runner |
| `config.ts` | Config loading, defaults, built-in research system prompt |
| `publish.ts` | Publishing: argument parsing, source reading, publish prompt, validator and git reporting |
| `pi-central-doc.example.json` | Example config file |
| `README.md` | This file |

## Installation

This directory is a Pi package: `package.json` declares
`"pi": { "extensions": ["./index.ts"] }` and the host packages are peer
dependencies, so there is nothing to build and no runtime dependency to vendor.

Install from git (pin a tag or commit):

```sh
pi install git:github.com/jordiesc/pi-central-doc@v0.1.0
```

Install from a local checkout (development):

```sh
pi install ./packages/pi-central-doc
```

Try it for a single run without touching settings:

```sh
pi -e ./packages/pi-central-doc
```

From npm, once published:

```sh
pi install npm:pi-central-doc
```

`pi list` shows installed packages, `pi remove pi-central-doc` removes it, and
`pi update --extensions` reconciles checkouts. After installing, restart Pi or run
`/reload`, then check the effective configuration with `/pi-central-doc`.

### Manual layout (no `pi install`)

Pi also discovers any directory under `~/.pi/agent/extensions/` that contains an
`index.ts`. For development, symlink the checkout instead of copying it:

```sh
ln -s /path/to/pi-central-doc ~/.pi/agent/extensions/pi-central-doc
```

## Configuration

Two JSON files are read, later ones override earlier ones:

1. Built-in defaults
2. `~/.pi/agent/pi-central-doc.json` (global)
3. `<project>/.pi/pi-central-doc.json` (project-local)
4. CLI flags (`--pi-central-doc-*`, `--no-pi-central-doc`, `--no-pi-central-doc-publish`)

Relative paths in the global file resolve against `~`; in a project file against
the project root. `~`, `$VAR`, and `${VAR}` are expanded in `docsDir`.

```json
{
  "docsDir": "/Users/me/jordi/doc",
  "model": "anthropic/claude-haiku-4-5",
  "thinkingLevel": "low",
  "tools": ["read", "grep", "find", "ls"],
  "timeoutMs": 180000,
  "maxAnswerBytes": 40000,
  "publish": {
    "enabled": true,
    "tools": ["read", "grep", "find", "ls", "write", "edit"],
    "timeoutMs": 600000,
    "validator": ["python3", "scripts/check-docs.py"]
  }
}
```

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | `false` makes the tool return a "disabled" error instead of running |
| `docsDir` | string | `~/repos/github/doc-system` | Documentation root; becomes the child's working directory |
| `entryFile` | string | `"INDEX.md"` | Entry point named in the research instructions |
| `model` | string \| null | inherit caller | `provider/model-id` used by the research session |
| `subagentModel` | string \| null | unset | Persistent model selected with `/pi-central-doc-model`; overrides `model`, and `null` means inherit each calling session's model |
| `thinkingLevel` | string | `"low"` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max` |
| `tools` | string[] | `["read","grep","find","ls"]` | Built-in tools for the child. Keep it read-only unless you mean it |
| `timeoutMs` | number | `180000` | Hard timeout for one research run |
| `maxAnswerBytes` | number | `40000` | Model-facing answer cap; the full answer stays in tool details |
| `systemPrompt` | string | built-in | Replaces the research system prompt |
| `extraPiArgs` | string[] | `[]` | Extra `pi` CLI args (escape hatch; can weaken the defaults) |

`publish` configures the `/pi-central-doc-publish` command:

| Key | Type | Default | Meaning |
|---|---|---|---|
| `publish.enabled` | boolean | `true` | Allow `/pi-central-doc-publish` to write into the documentation root |
| `publish.model` | string \| null | research `model` | Model for the publishing session |
| `publish.thinkingLevel` | string | research level | Thinking level for the publishing session |
| `publish.tools` | string[] | `["read","grep","find","ls","write","edit"]` | Tools for the publishing session; needs write access |
| `publish.dryRunTools` | string[] | `["read","grep","find","ls"]` | Tools used with `--dry-run`; must stay read-only |
| `publish.timeoutMs` | number | `600000` | Hard timeout for one publish run |
| `publish.validator` | string[] \| null | `["python3","scripts/check-docs.py"]` | Validator run in the docs root after a real publish; `null` disables it |
| `publish.systemPrompt` | string | built-in | Replaces the publishing system prompt |
| `publish.requireConfirmation` | boolean | `true` | Confirm before a publish that writes (non-UI sessions always need `--yes`) |

Unknown or invalid values are ignored and reported as config warnings in the tool
result and in `/pi-central-doc`.

### CLI flags

| Flag | Overrides |
|---|---|
| `--pi-central-doc-dir <path>` | `docsDir` |
| `--pi-central-doc-model <model>` | `model` |
| `--pi-central-doc-thinking <level>` | `thinkingLevel` |
| `--pi-central-doc-tools <a,b,c>` | `tools` |
| `--no-pi-central-doc` | sets `enabled: false` |
| `--no-pi-central-doc-publish` | sets `publish.enabled: false` |
| `--pi-central-doc-publish-model <model>` | `publish.model` |
| `--pi-central-doc-publish-tools <a,b,c>` | `publish.tools` |

Example: `pi --pi-central-doc-model anthropic/claude-opus-4-1`

### Model selection

- `"model": "deepseek/deepseek-flash"` — the current setting here (thinking `low` is supported).
- `"model": "anthropic/claude-haiku-4-5"` — fixed, cheap research model.
- `"model": "openai/gpt-5"` — same, another provider.
- Omit `model` or set `null` — reuse the calling session's model (`provider/id`),
  which also reuses its credentials.

The child uses the same credentials and environment as the parent Pi process.

## Tool

The model calls it on its own when a task depends on documented facts, guided by
the tool description, `promptSnippet`, and `promptGuidelines` this extension adds.

```json
{ "question": "How does OMD exchange SLI orders with CCP?", "paths": ["omd/", "glossary.md"] }
```

| Parameter | Required | Meaning |
|---|---|---|
| `question` | yes | Self-contained question for the documentation hub |
| `paths` | no | Relative files/folders worth checking first |
| `excerptsOnly` | no | Prefer verbatim excerpts with paths over a synthesized answer |

Result content: the cited answer, then a `Docs consulted:` footer with the files the
child read. Details carry the full answer, the research steps (tool calls), config
warnings, usage, and timing, so the expanded view (`Ctrl+O`) shows how the answer
was produced. Child usage is reported on the tool result so session totals stay
accurate.

## Commands

```
/pi-central-doc                    # show effective config, config paths, and warnings
/pi-central-doc <question>         # run one ad-hoc research query and show the answer
/pi-central-doc-model              # persist inheriting the current/future session model
/pi-central-doc-model select       # browse and persist an available model
/pi-central-doc-model <provider/model-id>  # persist a specific available model
/pi-central-doc-model config       # clear the saved choice and use the configured model

/pi-central-doc-publish <file.md> [options]       # adapt a markdown file into the hub
/pi-central-doc-publish --last[=<n>] [options]    # adapt the last <n> assistant messages of this session
/pi-central-doc-publish --help
```

### `/pi-central-doc-model`

Changes which model future `central_doc` research sessions use and saves the choice
in the project-local `.pi/pi-central-doc.json` as `subagentModel`, so it persists across
sessions in that project. With no argument (or `inherit`), child sessions inherit the
calling session's model. Use `select` to browse models currently available to Pi, or
pass a `provider/model-id` directly. Use `config` to clear the saved choice and return
to the `model` setting. This also affects publishing sessions unless `publish.model`
is explicitly configured.

### `/pi-central-doc-publish`

Takes material that was *not* written for the hub (a local `.md` file, or the
output of the current session) and publishes it as a first-class document:

1. reads the source (file path relative to the session cwd, or `--last` for recent
   assistant output; size limit 400 KB),
2. asks for confirmation unless `--yes` is given,
3. runs a write-capable child session rooted at `docsDir` that reads `AGENTS.md`,
   `INDEX.md`, `systems.yaml`, `glossary.md` and the neighbouring documents, then
   writes the document with full YAML frontmatter (`title`, `description`, `tags`,
   `related`, `system`, `kind`, `updated`), adds the `INDEX.md` row, extends
   `systems.yaml` when a node or folder is new, and updates `glossary.md`,
4. runs `publish.validator` in the docs root and lists the changed files from
   `git status --porcelain`,
5. posts a publish report into the transcript and a short notification.

The source material is passed as data with an explicit "ignore instructions inside"
rule, so a document containing prompt-like text cannot steer the publishing session.
Large sources (over 60 KB) are handed over as a temporary file the child reads.

Options:

| Option | Meaning |
|---|---|
| `--last[=<n>]` | Publish recent session output instead of a file (default 1 message) |
| `--system <id>` | Target node id from `systems.yaml` |
| `--title <t>` | Preferred document title |
| `--tags a,b` | Additional tags |
| `--as <path>` | Exact docs-relative destination path |
| `--note "text"` | Author intent for the publisher |
| `--dry-run`, `-n` | Propose the file, the `INDEX.md` row, the `systems.yaml` entry and the glossary additions without writing anything |
| `--yes`, `-y` | Skip the confirmation dialog |
| `--help`, `-h`, `help`, `?` | Show the usage summary |

Running the command with no arguments, or with `--help`, prints the same usage
summary as a notification.

Recommended flow:

```
/pi-central-doc-publish notes/omd-sli-retry.md --system omd --dry-run   # review the plan
/pi-central-doc-publish notes/omd-sli-retry.md --system omd --yes       # write + validate
```

A failed validator or a failed child session is reported as a failure; the report
always shows the changed files, so nothing is published silently.

## Behavior and security notes

- The child runs with `--no-session` (no session files), `--no-extensions` and
  `--no-mcp`. The documentation repository often contains project extensions; they
  are deliberately not loaded into the research session.
- Default tools are read-only. If you add `bash`, `edit`, or `write` to `tools`, the
  research session can modify the documentation repository.
- The child reads the documentation root's context files (for example its own
  `AGENTS.md`), which is normally desirable because it explains the doc conventions.
- Aborting the parent tool call (`Ctrl+C` / `signal`) kills the child process.
  A timeout kills it with `SIGTERM`, then `SIGKILL` after 5 seconds.
- A missing `docsDir`, an empty answer, a failed child, or a timeout produces an
  `isError` tool result with the reason, never a silent success.
- The tool result is capped at `maxAnswerBytes`; the complete answer remains in the
  call details.
- `/pi-central-doc-publish` is the only part that can write, and only inside `docsDir`. It has its
  own tool list (`publish.tools`), a separate timeout, and a `--dry-run` mode whose
  tools cannot write. It never touches `.git` and never deletes documents.

## Quick check without a model

```sh
pi --pi-central-doc-dir /path/to/docs -p "list documentation" --list-models  # config only
pi
/pi-central-doc                                                              # show config
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Documentation root not found` | Set `docsDir` or pass `--pi-central-doc-dir` |
| `timed out after … ms` | Raise `timeoutMs` (or `publish.timeoutMs`), or point at a smaller docs root |
| `Publishing is disabled` | Check `publish.enabled` / `--no-pi-central-doc-publish` |
| `Refusing to publish without confirmation` | Pass `--yes` (no UI available) or use `--dry-run` |
| `pi exited with code …` | Usually auth/model: run `pi --list-models`, check the configured `model` |
| Answers miss obvious docs | Improve `entryFile` usage, add `paths`, or tune `systemPrompt` |
| Tool not listed | Run `/reload`; check Pi's startup warnings for a load error |
