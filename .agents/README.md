# `.agents/`

Canonical agent configuration, following [AGENTS.md](https://agents.md) and
the [Agent Skills](https://agentskills.io) standard. Two tiers, nothing else:

| Tier | Contents |
|---|---|
| **Canonical**, committed | `AGENTS.md`, `skills/`, `mcp/servers.json`, `sync.py`, `setup`, and the environment hooks below |
| **Generated**, gitignored | Everything else a harness reads — MCP configs, skill symlinks, the one-line `CLAUDE.md`/`GEMINI.md` imports of `AGENTS.md` — rendered per checkout by `sync.py` for the harnesses detected on the machine |

A harness appears in this system only if something must be done for it — an
MCP config dialect, an instructions pointer, or skill symlinks (`sync.py
list` shows who gets what). Every other harness reads `AGENTS.md` and
`.agents/skills/` natively, needs no adapter, and is deliberately listed
nowhere: a new harness that follows the standards is supported implicitly,
with no template change.

The only committed harness-specific files are the hook carriers
(`.claude/settings.json`, `.cursor/environment.json`,
`copilot-setup-steps.yml`, the devcontainer): git deliberately executes
nothing from a fresh clone — a repo that could would be an attack vector —
so each harness's own committed hook format is the one place automation can
start from. Everything derivable is generated.

## Two-way sync

`python3 .agents/sync.py` converges both directions in one run:

- **Canon → harnesses**: renders MCP configs (`.mcp.json`, `.cursor/mcp.json`,
  `.codex/config.toml`, …) and skill symlinks (`.claude/skills/`,
  `.codebuddy/skills/`) from `.agents/`.
- **Harnesses → canon**: a skill directory dropped in a harness skills dir, or
  an MCP server added to any rendered config (`claude mcp add`, a hand edit),
  is adopted into `.agents/` and rendered back out to every other harness.

`setup` installs native git hooks so none of this is ever run by hand:
`post-checkout` and `post-merge` re-sync quietly after every pull or branch
switch, and `pre-commit` absorbs, re-renders, and stages the canonical result
itself — a commit that only needs converging just works, and it fails only
when a human must decide (conflicting skill contents, broken frontmatter, a
generated file force-added to git). CI runs the same `check`.

Third-party skills come through `npx skills add <repo>@<skill> -y`, and their
bookkeeping stays that tool's: it maintains the root `skills-lock.json`,
which the template doesn't ship — it appears with the first install and is
committed from then on (the pre-commit hook stages it automatically).
`sync.py` never touches the lock; it only fans the skills themselves out.

## Local overlay

`.agents/local/` is the personal tier: the same shape as `.agents/` —
`skills/`, `mcp/servers.json`, and an optional `AGENTS.md` of extra
instructions — but gitignored, so nothing in it reaches teammates or GitHub.
It overlays the canon on this machine: local skills and servers render into
every harness here, a local entry wins a name collision with the canon (so
you can point a server somewhere else just for yourself), and absorption
never moves local material into the canon. Personal instructions reach
Claude and Gemini through the generated `CLAUDE.md`/`GEMINI.md` imports;
harnesses that read `AGENTS.md` directly have no local-instructions hook, and
their native per-user files (`.claude/settings.local.json`,
`CLAUDE.local.md`) keep working alongside this.

To keep something you installed through a harness personal instead of shared,
move it into `.agents/local/` before committing — absorption's default is the
shared canon.

## Environments

Every environment reaches the same `.agents/setup` through its native,
committed hook — that one script is where project setup (dependencies,
codegen) goes.

Setup is isolation-aware: outside an isolated environment it touches nothing
beyond the repository, because a repo's setup must never rewrite personal
agent configs on someone's own machine. Only where `$HOME` belongs to the
project — a container or CI sandbox, detected by environment markers or the
`--isolated` flag a sandbox-only hook passes — does it also install
[rtk](https://github.com/rtk-ai/rtk) and hook it into every agent rtk
supports, with the target list read from rtk's own CLI so new rtk targets
need no template change. The devcontainer (the
[Dev Containers](https://containers.dev) standard: Codespaces, VS Code,
Cursor, DevPod, Ona, JetBrains) is the sanctioned way to get that isolation
on your own machine. Agents whose rtk integration is a project instruction
file, and agents rtk doesn't know, are covered by the rtk note in
`AGENTS.md`, which they all read natively.

rtk's version is rtk's own business: setup installs the latest release,
best-effort, and every rtk step degrades gracefully when it is unavailable
or changes shape. `AGENTS.md` ships with
a one-time bootstrap notice for environments with no hook; the first
successful run outside CI deletes it (the template repository itself,
matched by the `keep=` slug in the notice's marker, keeps it).

| Environment | Committed hook |
|---|---|
| Claude Code (web and local) | `SessionStart` hook in `.claude/settings.json`. The web UI's "Run setup script" step shows as skipped — that's the platform's own per-environment field, which a repo can't fill; setup runs a moment later, inside "Started Claude Code". Optionally paste `bash .agents/setup` into that field so a brand-new container's very first session also loads freshly generated MCP config at startup; later sessions have it either way (the container is cached after the hook). |
| Devcontainers: Codespaces, Ona, DevPod | `postCreateCommand` in `.devcontainer/devcontainer.json` |
| Cursor cloud agents | `install` in `.cursor/environment.json` |
| Copilot coding agent | `.github/workflows/copilot-setup-steps.yml` |
| Amp orbs | runs `.agents/setup` by convention |
| CI | `.github/workflows/agent-config.yml` |
| Codex cloud, Jules, Devin, … | no in-repo hook exists; paste `bash .agents/setup` into the environment's setup-script field. They read `AGENTS.md` and `.agents/skills/` natively, so this only matters once project setup does something. |

## Rules

- Edit skills in `.agents/skills/` and MCP servers in `mcp/servers.json`; the
  per-harness copies are generated. `mcp/servers.json` uses the Claude
  `mcpServers` dialect plus an optional `tools` read-only allowlist (rendered
  where supported: Codex `enabled_tools`, Gemini/Qwen `includeTools`).
- Credentials never go in configs — reference environment variables.
- To support a new harness, add one `HARNESSES` entry (and renderer) in
  `sync.py` and mirror its outputs in `.gitignore`'s generated block;
  `sync.py check` fails until both agree.
- Codex trusts a project `.codex/config.toml` only after you trust the
  project; `sync.py install-codex` writes the user-level config instead.
