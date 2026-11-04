#!/usr/bin/env python3
"""Two-way sync between the canonical agent config in .agents/ and harnesses.

Canonical, committed sources:
  .agents/skills/            shared skills (Agent Skills standard)
  .agents/mcp/servers.json   MCP servers, Claude `mcpServers` dialect plus an
                             optional `tools` read-only allowlist per server

Personal overlay, gitignored:
  .agents/local/             same shape (skills/, mcp/servers.json, and an
                             optional AGENTS.md of extra instructions).
                             Overlays the canon on this machine only — wins
                             name collisions, is never absorbed into the
                             canon, and never reaches the repository.

Forward: everything a harness reads is rendered from the canon per checkout
and gitignored — never hand-edited or committed; that includes the CLAUDE.md
and GEMINI.md one-line imports of AGENTS.md. Rendering runs automatically
through the committed environment hooks that call .agents/setup (table in
.agents/README.md) and the git hooks setup installs. Reverse: additions made
through one harness — a skill
directory dropped in .claude/skills/, a server added with `claude mcp add` or
a hand edit to any rendered config — are adopted into the canon on the next
sync and rendered back out to every other harness. A git pre-commit hook
installed by .agents/setup runs `check`, so a commit fails until local state
and canon have converged. Stdlib only, so all of this runs in any sandbox.

Usage:
  sync.py [harness ...]   absorb harness-local additions into the canon, then
                          render for detected harnesses plus any named ones
  sync.py --all           same, rendering every known harness (CI default)
  sync.py check           read-only: fail on unabsorbed local additions,
                          unrendered/broken skill links, or adapters that are
                          committed or unignored
  sync.py list            show known harnesses, detection state, and outputs
  sync.py install-codex   install this repo's MCP block into ~/.codex/config.toml

Only harnesses this repo must do something for — an MCP config dialect, an
instructions pointer, or skill symlinks — have an entry here. Every other
harness reads AGENTS.md and .agents/skills/ natively, needs nothing, and is
deliberately listed nowhere: a new harness that follows the standards is
supported implicitly.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

try:
    import tomllib
except ImportError:  # Python < 3.11: .codex/config.toml is skipped on absorb
    tomllib = None

REPO_ROOT = Path(__file__).resolve().parents[1]
SKILLS_ROOT = REPO_ROOT / ".agents" / "skills"
SERVERS_PATH = REPO_ROOT / ".agents" / "mcp" / "servers.json"
LOCAL_ROOT = REPO_ROOT / ".agents" / "local"
LOCAL_SKILLS = LOCAL_ROOT / "skills"
LOCAL_SERVERS = LOCAL_ROOT / "mcp" / "servers.json"
HASH_IGNORED = {".git", "node_modules", "__pycache__"}

# Each harness: how to detect it on this machine (env vars set, commands on
# PATH, directories under $HOME), where its per-skill symlinks go (None = it
# reads .agents/skills natively), and which renderer produces its config files
# (None = nothing to generate). Detection never probes a path sync.py itself
# creates — one run would make that harness sticky-detected.
HARNESSES = {
    "claude":    {"env": ["CLAUDECODE", "CLAUDE_CODE_REMOTE"], "cmd": ["claude"], "home": [".claude"], "skills": ".claude/skills", "render": "claude"},
    "codex":     {"cmd": ["codex"], "home": [".codex"], "skills": None, "render": "codex"},
    "cursor":    {"cmd": ["cursor-agent", "cursor"], "home": [".cursor"], "skills": None, "render": "cursor"},
    "gemini":    {"cmd": ["gemini"], "home": [".gemini"], "skills": None, "render": "gemini"},
    "qwen":      {"cmd": ["qwen"], "home": [".qwen"], "skills": None, "render": "qwen"},
    "opencode":  {"cmd": ["opencode"], "home": [".config/opencode"], "skills": None, "render": "opencode"},
    "vscode":    {"cmd": ["code"], "skills": None, "render": "vscode"},
    "kilo":      {"cmd": ["kilo"], "home": [".config/kilo"], "skills": None, "render": "kilo"},
    "factory":   {"cmd": ["droid"], "home": [".factory"], "skills": None, "render": "factory"},
    "amp":       {"cmd": ["amp"], "home": [".amp"], "skills": None, "render": "amp"},
    "codebuddy": {"cmd": ["codebuddy"], "home": [".codebuddy"], "skills": ".codebuddy/skills", "render": None},
}

def detected(spec):
    return (
        any(os.environ.get(var) for var in spec.get("env", ()))
        or any(shutil.which(cmd) for cmd in spec.get("cmd", ()))
        or any((Path.home() / rel).exists() for rel in spec.get("home", ()))
    )


def load_servers_file(path, required=True):
    if not required and not path.is_file():
        return {}
    try:
        servers = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise SystemExit(f"ERROR: cannot read {path}: {exc}")
    if not isinstance(servers, dict):
        raise SystemExit(f"ERROR: {path} must contain a JSON object")
    for name, config in servers.items():
        if not isinstance(name, str) or not name:
            raise SystemExit(f"ERROR: every MCP server in {path} needs a non-empty string name")
        if not isinstance(config, dict):
            raise SystemExit(f"ERROR: MCP server {name!r} must contain an object")
        if not isinstance(config.get("url"), str) and not isinstance(config.get("command"), str):
            raise SystemExit(f"ERROR: MCP server {name!r} needs a `url` or a `command`")
        tools = config.get("tools")
        if tools is not None and not (
            isinstance(tools, list) and all(isinstance(tool, str) and tool for tool in tools)
        ):
            raise SystemExit(f"ERROR: MCP server {name!r} has a malformed tools allowlist")
    return servers


def load_canon():
    return load_servers_file(SERVERS_PATH)


def load_local():
    return load_servers_file(LOCAL_SERVERS, required=False)


def load_servers():
    """The effective server set: canon overlaid by the personal local tier."""
    return {**load_canon(), **load_local()}


def json_document(value):
    return json.dumps(value, indent=2, ensure_ascii=False) + "\n"


def body_of(config):
    """The server config without the canonical-only `tools` allowlist."""
    return {key: value for key, value in config.items() if key != "tools"}


def is_remote(config):
    return "url" in config


# ── Renderers: canon → harness ────────────────────────────────────────────────
# Each takes the canonical servers dict and returns {relative path: content}.


def pointer_md(comment=False):
    """One-line import(s) of the instruction file(s) for CLAUDE.md/GEMINI.md."""
    text = "@AGENTS.md\n"
    if (LOCAL_ROOT / "AGENTS.md").is_file():
        text += "@.agents/local/AGENTS.md\n"
    if comment:
        text += ("\n<!-- Generated by .agents/sync.py (Claude Code strips this "
                 "comment); edit AGENTS.md or .agents/local/AGENTS.md instead. -->\n")
    return text


def render_claude(servers):
    # The committed .claude/settings.json (the SessionStart hook carrier)
    # enables all project MCP servers, so no approval list is rendered here.
    rendered = {}
    for name, config in servers.items():
        body = body_of(config)
        if is_remote(body):
            body.setdefault("type", "http")
        rendered[name] = body
    return {
        "CLAUDE.md": pointer_md(comment=True),
        ".mcp.json": json_document({"mcpServers": rendered}),
    }


def render_cursor(servers):
    rendered = {}
    for name, config in servers.items():
        body = body_of(config)
        body.pop("type", None)
        rendered[name] = body
    return {".cursor/mcp.json": json_document({"mcpServers": rendered})}


def render_vscode(servers):
    # VS Code names the top-level key `servers` and wants an explicit type.
    rendered = {}
    for name, config in servers.items():
        body = body_of(config)
        body.setdefault("type", "http" if is_remote(body) else "stdio")
        rendered[name] = body
    return {".vscode/mcp.json": json_document({"servers": rendered})}


def gemini_servers(servers):
    # Gemini CLI names streamable HTTP `httpUrl`, keeps `url` for SSE, and
    # spells the allowlist `includeTools`.
    rendered = {}
    for name, config in servers.items():
        body = body_of(config)
        transport = body.pop("type", None)
        if "url" in body and transport != "sse":
            body["httpUrl"] = body.pop("url")
        if config.get("tools"):
            body["includeTools"] = list(config["tools"])
        rendered[name] = body
    return rendered


def render_gemini(servers):
    # GEMINI.md imports AGENTS.md, so context needs no settings entry.
    return {
        "GEMINI.md": pointer_md(),
        ".gemini/settings.json": json_document({"mcpServers": gemini_servers(servers)}),
    }


def render_qwen(servers):
    document = {
        "contextFileName": ["AGENTS.md", "QWEN.md"],
        "mcpServers": gemini_servers(servers),
    }
    return {".qwen/settings.json": json_document(document)}


def opencode_mcp(servers):
    rendered = {}
    for name, config in servers.items():
        if is_remote(config):
            entry = {"type": "remote", "url": config["url"]}
            if config.get("headers"):
                entry["headers"] = config["headers"]
        else:
            entry = {"type": "local", "command": [config["command"], *config.get("args", [])]}
            if config.get("env"):
                entry["environment"] = config["env"]
        rendered[name] = entry
    return rendered


def render_opencode(servers):
    return {"opencode.json": json_document({"mcp": opencode_mcp(servers)})}


def render_kilo(servers):
    return {"kilo.jsonc": json_document({"mcp": opencode_mcp(servers)})}


def render_factory(servers):
    rendered = {}
    for name, config in servers.items():
        body = body_of(config)
        body.setdefault("type", "http" if is_remote(body) else "stdio")
        rendered[name] = body
    return {".factory/mcp.json": json_document({"mcpServers": rendered})}


def render_amp(servers):
    rendered = {name: body_of(config) for name, config in servers.items()}
    return {".amp/settings.json": json_document({"amp.mcpServers": rendered})}


def toml_key(value):
    if re.fullmatch(r"[A-Za-z0-9_-]+", value):
        return value
    return json.dumps(value, ensure_ascii=False)


def toml_value(value):
    if isinstance(value, str):
        # json.dumps escapes U+0000-U+001F but leaves U+007F raw, which TOML forbids.
        return json.dumps(value, ensure_ascii=False).replace("\x7f", "\\u007f")
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        return repr(value)
    if isinstance(value, list):
        return "[" + ", ".join(toml_value(item) for item in value) + "]"
    if isinstance(value, dict):
        pairs = (f"{toml_key(key)} = {toml_value(item)}" for key, item in value.items())
        return "{ " + ", ".join(pairs) + " }"
    raise SystemExit(f"ERROR: unsupported TOML value in MCP config: {value!r}")


def codex_toml(servers):
    lines = ["# Generated by .agents/sync.py; do not edit."]
    for name, config in servers.items():
        lines.extend(("", f"[mcp_servers.{toml_key(name)}]"))
        for key, value in config.items():
            if key in ("type", "tools"):
                continue
            lines.append(f"{toml_key(key)} = {toml_value(value)}")
        if config.get("tools"):
            lines.append(f"enabled_tools = {toml_value(list(config['tools']))}")
    return "\n".join(lines) + "\n"


def render_codex(servers):
    # Codex loads a project .codex/config.toml only once the project is
    # trusted; `install-codex` covers the user-level config instead.
    return {".codex/config.toml": codex_toml(servers)}


RENDERERS = {
    "claude": render_claude,
    "codex": render_codex,
    "cursor": render_cursor,
    "gemini": render_gemini,
    "qwen": render_qwen,
    "opencode": render_opencode,
    "vscode": render_vscode,
    "kilo": render_kilo,
    "factory": render_factory,
    "amp": render_amp,
}


def output_paths():
    """Every repo-relative path any renderer can write, across all harnesses."""
    servers = load_servers()
    paths = set()
    for spec in HARNESSES.values():
        if spec["render"]:
            paths.update(RENDERERS[spec["render"]](servers))
        if spec["skills"]:
            # Trailing slash: `git check-ignore` only matches a directory-only
            # .gitignore pattern when the path is spelled as a directory.
            paths.add(spec["skills"] + "/")
    return sorted(paths)


# ── Absorption: harness → canon ───────────────────────────────────────────────
# Additions made through one harness are adopted into the canon, so the next
# render propagates them to every other harness.


def strip_default_type(entry):
    config = dict(entry)
    if config.get("type") in ("http", "stdio"):
        del config["type"]
    return config


def from_gemini(entry):
    config = dict(entry)
    if "httpUrl" in config:
        config["url"] = config.pop("httpUrl")
    if "includeTools" in config:
        config["tools"] = config.pop("includeTools")
    return strip_default_type(config)


def from_opencode(entry):
    config = dict(entry)
    kind = config.pop("type", None)
    command = config.pop("command", None)
    if kind == "local" and isinstance(command, list) and command:
        config["command"] = command[0]
        if command[1:]:
            config["args"] = list(command[1:])
    elif command is not None:
        config["command"] = command
    if "environment" in config:
        config["env"] = config.pop("environment")
    return config


def from_codex(entry):
    config = dict(entry)
    if "enabled_tools" in config:
        config["tools"] = config.pop("enabled_tools")
    return config


# Where each harness's config gains servers out-of-band (`claude mcp add`, a
# hand edit, another agent's installer), and how to read entries back into the
# canonical dialect.
FOREIGN_SOURCES = (
    (".mcp.json", ("mcpServers",), strip_default_type),
    (".cursor/mcp.json", ("mcpServers",), strip_default_type),
    (".vscode/mcp.json", ("servers",), strip_default_type),
    (".factory/mcp.json", ("mcpServers",), strip_default_type),
    (".gemini/settings.json", ("mcpServers",), from_gemini),
    (".qwen/settings.json", ("mcpServers",), from_gemini),
    ("opencode.json", ("mcp",), from_opencode),
    ("kilo.jsonc", ("mcp",), from_opencode),
    (".amp/settings.json", ("amp.mcpServers",), strip_default_type),
    (".codex/config.toml", ("mcp_servers",), from_codex),
)


def foreign_servers(servers):
    """Servers found in a harness config on disk but missing from the canon.

    Returns ({name: (canonical config, source path)}, [unreadable-file notes]).
    """
    found, problems = {}, []
    for rel, keys, normalize in FOREIGN_SOURCES:
        path = REPO_ROOT / rel
        if not path.is_file():
            continue
        try:
            if rel.endswith(".toml"):
                if tomllib is None:
                    continue
                data = tomllib.loads(path.read_text(encoding="utf-8"))
            else:
                data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            problems.append(f"{rel}: unreadable, rendering will replace it ({exc})")
            continue
        for key in keys:
            data = data.get(key) if isinstance(data, dict) else None
        if not isinstance(data, dict):
            continue
        for name, entry in data.items():
            if name in servers or name in found or not isinstance(entry, dict):
                continue
            config = normalize(entry)
            if isinstance(config.get("url"), str) or isinstance(config.get("command"), str):
                found[name] = (config, rel)
    return found, problems


def foreign_skills():
    """Real directories inside a harness skills dir; canon holds only symlinks."""
    found = []
    for spec in HARNESSES.values():
        if not spec["skills"]:
            continue
        target_dir = REPO_ROOT / spec["skills"]
        if not target_dir.is_dir():
            continue
        found.extend(
            (spec["skills"], entry)
            for entry in sorted(target_dir.iterdir())
            if entry.is_dir() and not entry.is_symlink()
        )
    return found


def absorb(canon, local):
    """Adopt harness-local additions into the canon before rendering.

    Entries from the personal .agents/local/ tier count as known and are
    never adopted; genuinely new material always lands in the shared canon —
    anyone who wants an addition to stay personal moves it to .agents/local/.
    """
    adopted_skills = []
    for rel, entry in foreign_skills():
        canonical = SKILLS_ROOT / entry.name
        if canonical.exists():
            if skill_hash(canonical) != skill_hash(entry):
                raise SystemExit(
                    f"ERROR: {rel}/{entry.name} and .agents/skills/{entry.name} differ; "
                    "merge them manually — .agents/skills is the canon."
                )
            shutil.rmtree(entry)  # identical duplicate; the symlink replaces it
        else:
            SKILLS_ROOT.mkdir(parents=True, exist_ok=True)
            shutil.move(str(entry), str(canonical))
            adopted_skills.append(entry.name)
            print(f"Adopted skill {entry.name!r} from {rel}/ into .agents/skills/")

    adopted_servers, _ = foreign_servers({**canon, **local})
    for name, (config, rel) in adopted_servers.items():
        canon[name] = config
        print(f"Adopted MCP server {name!r} from {rel} into .agents/mcp/servers.json")
    if adopted_servers:
        atomic_write(SERVERS_PATH, json_document(canon))
    if adopted_skills or adopted_servers:
        print("Commit the updated files under .agents/.")


# ── Skill symlinks ────────────────────────────────────────────────────────────


def symlinks_supported():
    """Whether this machine can create symlinks (Windows may need Developer
    Mode); when it can't, skill linking degrades to a warning, in sync and
    check alike, instead of breaking setup."""
    global _SYMLINKS_SUPPORTED
    if _SYMLINKS_SUPPORTED is None:
        try:
            with tempfile.TemporaryDirectory() as probe:
                os.symlink("probe-target", os.path.join(probe, "probe"))
            _SYMLINKS_SUPPORTED = True
        except OSError:
            _SYMLINKS_SUPPORTED = False
    return _SYMLINKS_SUPPORTED


_SYMLINKS_SUPPORTED = None


def skill_names():
    """Canonical (committed, shared) skills only."""
    if not SKILLS_ROOT.is_dir():
        return []
    return sorted(path.name for path in SKILLS_ROOT.iterdir() if path.is_dir())


def skill_sources():
    """{name: source dir} across canon and local; local wins a name collision."""
    sources = {}
    for root in (SKILLS_ROOT, LOCAL_SKILLS):
        if root.is_dir():
            for path in sorted(root.iterdir()):
                if path.is_dir():
                    sources[path.name] = path
    return sources


def sync_skills(target_rel):
    sources = skill_sources()
    target_dir = REPO_ROOT / target_rel
    if not sources and not target_dir.is_dir():
        return  # nothing to link and nothing stale to prune
    if sources and not symlinks_supported():
        print(f"WARNING: symlinks unavailable; {target_rel} won't see shared "
              "skills on this machine.", file=sys.stderr)
        return
    target_dir.mkdir(parents=True, exist_ok=True)

    for name, source in sources.items():
        link_target = Path(os.path.relpath(source, target_dir))
        link_path = target_dir / name
        if link_path.is_symlink():
            if os.readlink(link_path) == str(link_target):
                continue
            link_path.unlink()
        elif link_path.exists():
            raise SystemExit(f"ERROR: {link_path} exists but is not a symlink.")
        link_path.symlink_to(link_target)

    for link_path in target_dir.iterdir():
        if not link_path.is_symlink():
            continue
        resolved = Path(os.path.normpath(target_dir / os.readlink(link_path)))
        if resolved.parent in (SKILLS_ROOT, LOCAL_SKILLS) and not resolved.exists():
            link_path.unlink()


def skill_link_failures(target_rel):
    """If this skills dir was rendered, its links must be complete and live."""
    sources = skill_sources()
    target_dir = REPO_ROOT / target_rel
    if not target_dir.is_dir() or not symlinks_supported():
        return []
    failures = [
        f"{target_rel}/{name}: missing or broken symlink (run .agents/sync.py)"
        for name in sources
        if not (target_dir / name).is_symlink() or not (target_dir / name).exists()
    ]
    failures.extend(
        f"{target_rel}/{link.name}: dangling symlink (run .agents/sync.py)"
        for link in target_dir.iterdir()
        if link.is_symlink() and not link.exists() and link.name not in sources
    )
    return failures


# ── Skill hashing (for duplicate detection during absorption) ─────────────────


def skill_hash(skill_root):
    """Hash a skill directory: sorted relative path plus file bytes."""
    digest = hashlib.sha256()
    files = [
        path
        for path in skill_root.rglob("*")
        if path.is_file() and not HASH_IGNORED.intersection(path.relative_to(skill_root).parts)
    ]
    for path in sorted(files, key=lambda path: path.relative_to(skill_root).as_posix()):
        digest.update(path.relative_to(skill_root).as_posix().encode("utf-8"))
        digest.update(path.read_bytes())
    return digest.hexdigest()


# ── Modes ─────────────────────────────────────────────────────────────────────


def atomic_write(path, content):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(content)
        try:
            mode = path.stat().st_mode & 0o777
        except OSError:
            mode = 0o644
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def active_harnesses(arguments):
    """Detected harnesses plus any named ones; environment hooks name their own.

    A name with no entry needs nothing rendered — harnesses that follow the
    standards are supported implicitly — so it is noted and skipped, never
    refused.
    """
    named = [argument for argument in arguments if not argument.startswith("-")]
    for name in sorted(set(named) - set(HARNESSES)):
        print(f"{name}: nothing to render (reads AGENTS.md and .agents/skills natively)")
    if "--all" in arguments or os.environ.get("GITHUB_ACTIONS") == "true":
        return list(HARNESSES)
    return [name for name, spec in HARNESSES.items() if name in named or detected(spec)]


def sync(arguments):
    canon, local = load_canon(), load_local()
    absorb(canon, local)
    servers = {**canon, **local}
    active = active_harnesses(arguments)
    generated = []
    for name in active:
        spec = HARNESSES[name]
        files = RENDERERS[spec["render"]](servers) if spec["render"] else {}
        for rel, content in files.items():
            path = REPO_ROOT / rel
            try:
                if path.read_text(encoding="utf-8") == content:
                    continue  # unchanged; don't churn mtimes or clobber
            except OSError:
                pass
            atomic_write(path, content)
        if spec["skills"]:
            sync_skills(spec["skills"])
            files = {**files, spec["skills"] + "/": None}
        if files:
            generated.append(f"{name}: {', '.join(sorted(files))}")
    # Heal skill links a past render created for harnesses not active now.
    for name, spec in HARNESSES.items():
        if name not in active and spec["skills"] and (REPO_ROOT / spec["skills"]).is_dir():
            sync_skills(spec["skills"])
    for line in generated:
        print(f"Generated {line}")
    if not generated:
        print("No harnesses detected; run with --all or name one to force.")


def git(*arguments):
    return subprocess.run(
        ["git", "-C", str(REPO_ROOT), *arguments],
        capture_output=True, text=True, check=False,
    ).stdout.splitlines()


def check():
    """Read-only verification of every invariant; the pre-commit hook runs this.

    Generated adapters must be gitignored and out of the index, harness-local
    additions must be absorbed into the canon, rendered output must parse,
    and rendered skill symlinks must resolve.
    """
    failures = []

    # The personal overlay must stay ignored and uncommitted, like adapters.
    outputs = output_paths() + [".agents/local/"]
    tracked = git("ls-files", "--", *outputs)
    # --no-index: a tracked path would otherwise also be reported as unignored.
    ignored = set(git("check-ignore", "--no-index", "--", *outputs))
    failures.extend(f"{path}: committed generated adapter; remove it from git" for path in tracked)
    failures.extend(
        f"{path}: missing from .gitignore" for path in outputs if path not in ignored
    )

    servers = load_servers()
    for rel, entry in foreign_skills():
        failures.append(f"{rel}/{entry.name}: skill not in .agents/skills (run .agents/sync.py)")
    foreign, problems = foreign_servers(servers)
    failures.extend(
        f"{rel}: MCP server {name!r} not in .agents/mcp/servers.json (run .agents/sync.py)"
        for name, (_, rel) in foreign.items()
    )
    failures.extend(problems)

    for spec in HARNESSES.values():
        if spec["render"]:
            for rel, content in RENDERERS[spec["render"]](servers).items():
                try:
                    if rel.endswith(".toml"):
                        if tomllib:
                            tomllib.loads(content)
                    elif rel.endswith((".json", ".jsonc")):
                        json.loads(content)
                except ValueError as exc:
                    failures.append(f"{rel}: renderer produced invalid output: {exc}")
        if spec["skills"]:
            failures.extend(skill_link_failures(spec["skills"]))

    for rel in (".claude/settings.json", ".cursor/environment.json",
                ".devcontainer/devcontainer.json"):
        try:
            json.loads((REPO_ROOT / rel).read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            failures.append(f"{rel}: {exc}")

    if failures:
        print("Agent config problems:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        raise SystemExit(1)
    print(f"OK: {len(outputs)} generated paths ignored, {len(skill_sources())} skill(s) linked.")


def list_harnesses():
    servers = load_servers()
    for name, spec in HARNESSES.items():
        adapters = []
        if spec["skills"]:
            adapters.append(f"skills → {spec['skills']}")
        if spec["render"]:
            adapters.append("files → " + ", ".join(sorted(RENDERERS[spec["render"]](servers))))
        state = "detected" if detected(spec) else "not detected"
        print(f"{name:10} {state:13} {'; '.join(adapters)}")
    print("Any harness not listed reads AGENTS.md and .agents/skills natively; nothing to render.")


def install_codex():
    repo_name = re.sub(r"[^A-Za-z0-9_-]+", "-", REPO_ROOT.name).strip("-") or "repo"
    begin = f"# BEGIN {repo_name} managed MCP"
    end = f"# END {repo_name} managed MCP"
    block = begin + "\n" + codex_toml(load_servers()) + end
    user_config = Path.home() / ".codex" / "config.toml"
    try:
        current = user_config.read_text(encoding="utf-8")
    except FileNotFoundError:
        current = ""
    pattern = re.compile(
        rf"(?ms)^[ \t]*{re.escape(begin)}\n.*?^[ \t]*{re.escape(end)}[ \t]*\n?"
    )
    current = re.sub(r"\n{3,}", "\n\n", pattern.sub("", current)).rstrip()
    merged = (current + "\n\n" if current else "") + block + "\n"
    atomic_write(user_config, merged)
    print(f"Installed managed MCP block: {user_config}")


def main(arguments):
    modes = {"check": check, "list": list_harnesses, "install-codex": install_codex}
    if arguments and arguments[0] in modes:
        if arguments[1:]:
            raise SystemExit(f"ERROR: {arguments[0]} takes no further arguments")
        modes[arguments[0]]()
    elif all(argument == "--all" or not argument.startswith("-") for argument in arguments):
        sync(arguments)
    else:
        print(__doc__, file=sys.stderr)
        raise SystemExit(2)


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except BrokenPipeError:
        raise SystemExit(0)
