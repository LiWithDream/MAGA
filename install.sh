#!/usr/bin/env bash
set -euo pipefail

# AGY Studio (formerly MAGA) one-command installer for macOS.
# Supports:
#   1) Prebuilt Release tarball (zero npm install, zero esbuild)
#   2) Local git clone (auto-runs `npm install` when node_modules/esbuild is missing)
#   3) Remote pipe (`curl -fsSL ... | bash`) cloning to $AGY_STUDIO_INSTALL_DIR

DRY_RUN=0
NO_RULES=0
INSTALL_DIR="${AGY_STUDIO_INSTALL_DIR:-${MAGA_INSTALL_DIR:-$HOME/.local/share/agy-studio}}"
REPO_URL="${AGY_STUDIO_REPO_URL:-${MAGA_REPO_URL:-https://github.com/LiWithDream/agy-studio.git}}"

usage() {
  cat <<'EOF'
Usage: install.sh [options]

Options:
  --dry-run        Print resolved Node binary, mode, and commands without modifying files
  --dir <path>     Target directory when cloning via curl | bash (default: ~/.local/share/agy-studio)
  --no-rules       Skip syncing 7-line phase-sync rules into ~/.gemini/AGENTS.md
  -h, --help       Show this help message
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

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "AGY Studio currently supports macOS only (uses LaunchAgent + macOS CDP bootstrap)." >&2
  echo "Windows & Linux support is tracked on GitHub Issues — feel free to upvote it." >&2
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

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] os=Darwin"
  echo "[dry-run] node=$NODE_BIN ($("$NODE_BIN" -v))"
  echo "[dry-run] mode=$MODE"
  echo "[dry-run] targetDir=$TARGET_DIR"
  case "$MODE" in
    prebuilt)
      echo "[dry-run] exec: MAGA_USE_PREBUILT=1 \"$NODE_BIN\" studio/cli.mjs ${CLI_ARGS[*]}"
      ;;
    source)
      echo "[dry-run] exec: \"$NODE_BIN\" studio/cli.mjs ${CLI_ARGS[*]}"
      ;;
    source-bootstrap)
      echo "[dry-run] exec: npm install --no-audit --no-fund && \"$NODE_BIN\" studio/cli.mjs ${CLI_ARGS[*]}"
      ;;
    remote-clone)
      echo "[dry-run] exec: git clone \"$REPO_URL\" \"$TARGET_DIR\" && cd \"$TARGET_DIR\" && npm install --no-audit --no-fund && \"$NODE_BIN\" studio/cli.mjs ${CLI_ARGS[*]}"
      ;;
  esac
  exit 0
fi

if [[ "$MODE" == "remote-clone" ]]; then
  command -v git >/dev/null 2>&1 || { echo "Error: git is required for remote install." >&2; exit 1; }
  if [[ -d "$TARGET_DIR/.git" ]]; then
    echo "Updating existing AGY Studio clone at $TARGET_DIR..."
    git -C "$TARGET_DIR" pull --ff-only
  else
    mkdir -p "$(dirname "$TARGET_DIR")"
    echo "Cloning AGY Studio into $TARGET_DIR..."
    git clone "$REPO_URL" "$TARGET_DIR"
  fi
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
  npm install --no-audit --no-fund
  "$NODE_BIN" studio/cli.mjs "${CLI_ARGS[@]}"
else
  "$NODE_BIN" studio/cli.mjs "${CLI_ARGS[@]}"
fi

echo "Done. Run 'node \"$TARGET_DIR/studio/cli.mjs\" doctor' to verify live status."
