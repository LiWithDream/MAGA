#!/usr/bin/env bash
set -euo pipefail

# AGY Studio (formerly MAGA) one-command installer for macOS.
# Supports:
#   1) Prebuilt Release tarball (zero npm install, zero esbuild)
#   2) Local git clone (auto-runs `npm install` when node_modules/esbuild is missing)
#   3) Remote pipe (`curl -fsSL ... | bash`) cloning to $AGY_STUDIO_INSTALL_DIR

DRY_RUN=0
NO_RULES=0
PREVIEW=0
FORCE=0
CHANNEL_RAW="${AGY_STUDIO_CHANNEL:-}"
CHANNEL_EXPLICIT=0
if [[ -n "$CHANNEL_RAW" ]]; then
  CHANNEL_EXPLICIT=1
fi
INSTALL_DIR="${AGY_STUDIO_INSTALL_DIR:-${MAGA_INSTALL_DIR:-$HOME/.local/share/agy-studio}}"
REPO_URL="${AGY_STUDIO_REPO_URL:-${MAGA_REPO_URL:-https://github.com/LiWithDream/agy-studio.git}}"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --dry-run             Print resolved Node binary, mode, channel, and commands without modifying files
  --channel <name>      Release channel when syncing git clones: stable (default, latest Release tag) or edge (main)
  --dir <path>          Target directory when cloning via curl | bash (default: ~/.local/share/agy-studio)
  --no-rules            Skip syncing 7-line phase-sync rules into ~/.gemini/AGENTS.md
  --preview             Allow preview install from a non-main branch or linked worktree
  --force               Allow install from a dirty working tree (auto-stashes during channel switch)
  -h, --help            Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --no-rules)
      NO_RULES=1
      shift
      ;;
    --preview)
      PREVIEW=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    --channel)
      [[ $# -ge 2 ]] || { echo "Error: --channel requires stable or edge" >&2; exit 2; }
      CHANNEL_RAW="$2"
      CHANNEL_EXPLICIT=1
      shift 2
      ;;
    --channel=*)
      CHANNEL_RAW="${1#*=}"
      CHANNEL_EXPLICIT=1
      shift
      ;;
    --dir)
      [[ $# -ge 2 ]] || { echo "Error: --dir requires a path argument" >&2; exit 2; }
      INSTALL_DIR="$2"
      shift 2
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

CHANNEL="$(printf '%s' "${CHANNEL_RAW:-stable}" | tr '[:upper:]' '[:lower:]')"
if [[ "$CHANNEL" != "stable" && "$CHANNEL" != "edge" ]]; then
  echo "Error: invalid --channel '$CHANNEL_RAW' (expected 'stable' or 'edge')." >&2
  usage >&2
  exit 2
fi

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "AGY Studio install.sh supports macOS only (uses LaunchAgent + macOS CDP bootstrap)." >&2
  echo "On Windows 10/11, use install.ps1; Linux support is tracked on GitHub Issues." >&2
  exit 1
fi

node_major_of() {
  local bin="$1"
  local ver
  ver="$("$bin" -p "process.versions.node.split('.')[0]" 2>/dev/null || echo 0)"
  if [[ "$ver" =~ ^[0-9]+$ ]]; then
    echo "$ver"
  else
    echo 0
  fi
}

resolve_node() {
  local candidates=()
  if command -v node >/dev/null 2>&1; then
    candidates+=("$(command -v node)")
  fi
  candidates+=("/opt/homebrew/bin/node" "/usr/local/bin/node")

  local glob_cand
  for glob_cand in \
    "$HOME"/.nvm/versions/node/*/bin/node \
    "$HOME"/.local/share/fnm/node-versions/*/installation/bin/node \
    "$HOME"/.volta/bin/node; do
    if [[ -x "$glob_cand" ]]; then
      candidates+=("$glob_cand")
    fi
  done

  local cand major
  for cand in "${candidates[@]}"; do
    if [[ -x "$cand" ]]; then
      major="$(node_major_of "$cand")"
      if (( major >= 22 )); then
        echo "$cand"
        return 0
      fi
    fi
  done
  return 1
}

if ! NODE_BIN="$(resolve_node)"; then
  echo "Error: Node.js >= 22 is required on macOS." >&2
  echo "Install via Homebrew: brew install node" >&2
  exit 1
fi

NODE_DIR="$(dirname "$NODE_BIN")"
export PATH="$NODE_DIR:$PATH"

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
fi

TARGET_DIR=""
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/studio/cli.mjs" ]]; then
  TARGET_DIR="$SCRIPT_DIR"
elif [[ -n "$SCRIPT_SOURCE" || -t 0 ]] && [[ -f "$PWD/studio/cli.mjs" ]]; then
  # Only trust $PWD when executed from a local file or interactive TTY, never when piped via `curl | bash`.
  TARGET_DIR="$PWD"
fi

if [[ -n "$TARGET_DIR" ]]; then
  if [[ -f "$TARGET_DIR/user/custom.js" && -f "$TARGET_DIR/studio/prebuilt/studio-entry.js" ]]; then
    MODE="prebuilt"
  elif [[ -d "$TARGET_DIR/node_modules/esbuild" ]]; then
    MODE="source"
  else
    MODE="source-bootstrap"
  fi
else
  MODE="remote-clone"
  TARGET_DIR="$INSTALL_DIR"
fi

CLI_ARGS=("install")
if [[ "$NO_RULES" -eq 1 ]]; then
  CLI_ARGS+=("--no-rules")
fi
if [[ "$PREVIEW" -eq 1 ]]; then
  CLI_ARGS+=("--preview")
fi
if [[ "$FORCE" -eq 1 ]]; then
  CLI_ARGS+=("--force")
fi

resolve_stable_tag() {
  local target_dir="$1"
  local repo_url="$2"
  "$NODE_BIN" --input-type=module - "$target_dir" "$repo_url" <<'EOF'
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const targetDir = process.argv[2] || '';
const repoUrl = process.argv[3] || '';
const TAG_RE = /^v(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

const envTag = String(process.env.AGY_STUDIO_RELEASE_TAG || '').trim();
if (TAG_RE.test(envTag)) {
  process.stdout.write(`${envTag}\n`);
  process.exit(0);
}

const ghMatch = repoUrl.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
if (ghMatch && typeof fetch === 'function') {
  try {
    const apiUrl = `https://api.github.com/repos/${ghMatch[1]}/${ghMatch[2]}/releases/latest`;
    const res = await fetch(apiUrl, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'agy-studio-installer' },
      signal: AbortSignal.timeout(5000),
    });
    if (res.ok) {
      const data = await res.json();
      const tag = String(data?.tag_name || '').trim();
      if (TAG_RE.test(tag)) {
        process.stdout.write(`${tag}\n`);
        process.exit(0);
      }
    }
  } catch {}
}

let expectedMajor = 1;
try {
  const pkgRaw = execFileSync('git', ['-C', targetDir, 'show', 'origin/main:package.json'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  const m = String(JSON.parse(pkgRaw)?.version || '').match(/^(\d+)\./);
  if (m) expectedMajor = Number(m[1]);
} catch {
  try {
    const localPkg = JSON.parse(fs.readFileSync(path.join(targetDir, 'package.json'), 'utf8'));
    const m = String(localPkg?.version || '').match(/^(\d+)\./);
    if (m) expectedMajor = Number(m[1]);
  } catch {}
}

let lsOut = '';
try {
  lsOut = execFileSync('git', ['ls-remote', '--tags', '--refs', repoUrl, 'refs/tags/v*'], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
} catch {}

const parsed = [];
for (const line of lsOut.split(/\r?\n/)) {
  const m = line.match(/refs\/tags\/(v(\d+)\.(\d+)\.(\d+))$/);
  if (!m) continue;
  const tag = m[1];
  const major = Number(m[2]);
  if (major > expectedMajor) continue;
  parsed.push({ tag, major, minor: Number(m[3]), patch: Number(m[4]) });
}
parsed.sort((a, b) => (b.major - a.major) || (b.minor - a.minor) || (b.patch - a.patch));
if (parsed[0]) {
  process.stdout.write(`${parsed[0].tag}\n`);
  process.exit(0);
}
process.exit(1);
EOF
}

sync_git_channel() {
  local target_dir="$1"
  local repo_url="$2"
  local channel="$3"
  if [[ -n "$(git -C "$target_dir" status --porcelain)" ]]; then
    if [[ "$FORCE" -eq 1 ]]; then
      echo "Stashing local uncommitted changes in $target_dir (--force)..."
      git -C "$target_dir" stash push -u -m "agy-studio-installer-autostash"
    else
      echo "Error: $target_dir has local uncommitted changes. Commit/stash them or re-run with --force." >&2
      exit 1
    fi
  fi
  git -C "$target_dir" fetch --prune origin main
  if [[ "$channel" == "edge" ]]; then
    echo "Switching $target_dir to edge channel (origin/main)..."
    git -C "$target_dir" checkout -B main origin/main
  else
    local stable_tag=""
    if ! stable_tag="$(resolve_stable_tag "$target_dir" "$repo_url")" || [[ -z "$stable_tag" ]]; then
      echo "Error: could not resolve latest stable release tag from $repo_url (pass --channel edge to track main)." >&2
      exit 1
    fi
    echo "Switching $target_dir to stable release $stable_tag..."
    git -C "$target_dir" fetch --prune origin "refs/tags/$stable_tag:refs/tags/$stable_tag"
    git -C "$target_dir" checkout --detach "refs/tags/$stable_tag"
  fi
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] os=Darwin"
  echo "[dry-run] channel=$CHANNEL"
  echo "[dry-run] node=$NODE_BIN ($("$NODE_BIN" -v))"
  echo "[dry-run] mode=$MODE"
  echo "[dry-run] targetDir=$TARGET_DIR"
  NPM_BOOT_CMD="npm install --no-audit --no-fund"
  if [[ "$MODE" == "remote-clone" || -f "$TARGET_DIR/package-lock.json" ]]; then
    NPM_BOOT_CMD="npm ci --no-audit --no-fund"
  fi
  CHANNEL_STEP="git -C \"$TARGET_DIR\" checkout --detach <latest-stable-tag>"
  if [[ "$CHANNEL" == "edge" ]]; then
    CHANNEL_STEP="git -C \"$TARGET_DIR\" checkout -B main origin/main"
  fi
  case "$MODE" in
    prebuilt)
      echo "[dry-run] exec: MAGA_USE_PREBUILT=1 \"$NODE_BIN\" studio/cli.mjs ${CLI_ARGS[*]}"
      ;;
    source)
      echo "[dry-run] exec: \"$NODE_BIN\" studio/cli.mjs ${CLI_ARGS[*]}"
      ;;
    source-bootstrap)
      echo "[dry-run] exec: $NPM_BOOT_CMD && \"$NODE_BIN\" studio/cli.mjs ${CLI_ARGS[*]}"
      ;;
    remote-clone)
      echo "[dry-run] exec: git clone \"$REPO_URL\" \"$TARGET_DIR\" && $CHANNEL_STEP && cd \"$TARGET_DIR\" && $NPM_BOOT_CMD && \"$NODE_BIN\" studio/cli.mjs ${CLI_ARGS[*]}"
      ;;
  esac
  exit 0
fi

if [[ "$MODE" == "remote-clone" ]]; then
  command -v git >/dev/null 2>&1 || { echo "Error: git is required for remote install." >&2; exit 1; }
  if [[ -d "$TARGET_DIR/.git" ]]; then
    echo "Updating existing AGY Studio clone at $TARGET_DIR..."
  else
    mkdir -p "$(dirname "$TARGET_DIR")"
    echo "Cloning AGY Studio into $TARGET_DIR..."
    git clone "$REPO_URL" "$TARGET_DIR"
  fi
  sync_git_channel "$TARGET_DIR" "$REPO_URL" "$CHANNEL"
  if [[ -f "$TARGET_DIR/user/custom.js" && -f "$TARGET_DIR/studio/prebuilt/studio-entry.js" ]]; then
    MODE="prebuilt"
  elif [[ -d "$TARGET_DIR/node_modules/esbuild" ]]; then
    MODE="source"
  else
    MODE="source-bootstrap"
  fi
elif [[ "$CHANNEL_EXPLICIT" -eq 1 && -d "$TARGET_DIR/.git" ]]; then
  command -v git >/dev/null 2>&1 || { echo "Error: git is required to switch release channels." >&2; exit 1; }
  sync_git_channel "$TARGET_DIR" "$REPO_URL" "$CHANNEL"
  if [[ -f "$TARGET_DIR/user/custom.js" && -f "$TARGET_DIR/studio/prebuilt/studio-entry.js" ]]; then
    MODE="prebuilt"
  elif [[ -d "$TARGET_DIR/node_modules/esbuild" ]]; then
    MODE="source"
  else
    MODE="source-bootstrap"
  fi
fi

cd "$TARGET_DIR"

if [[ "$MODE" == "prebuilt" ]]; then
  MAGA_USE_PREBUILT=1 "$NODE_BIN" studio/cli.mjs "${CLI_ARGS[@]}"
elif [[ "$MODE" == "source-bootstrap" ]]; then
  command -v npm >/dev/null 2>&1 || { echo "Error: npm is required to install build dependencies (esbuild)." >&2; exit 1; }
  echo "Installing build dependencies (esbuild)..."
  if [[ -f "$TARGET_DIR/package-lock.json" ]]; then
    npm ci --no-audit --no-fund
  else
    npm install --no-audit --no-fund
  fi
  "$NODE_BIN" studio/cli.mjs "${CLI_ARGS[@]}"
else
  "$NODE_BIN" studio/cli.mjs "${CLI_ARGS[@]}"
fi

echo "Done. Run 'node \"$TARGET_DIR/studio/cli.mjs\" doctor' to verify live status."
