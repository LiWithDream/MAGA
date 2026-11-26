#!/usr/bin/env bash
set -euo pipefail

# Cleanly removes AGY Studio injection, LaunchAgent daemon, and injected AGENTS.md rules
# while keeping Antigravity chats and personal studio-prefs.json intact unless --purge is passed.

DRY_RUN=0
PURGE=0
INSTALL_DIR="${AGY_STUDIO_INSTALL_DIR:-${MAGA_INSTALL_DIR:-$HOME/.local/share/agy-studio}}"

usage() {
  cat <<'EOF'
Usage: uninstall.sh [options]

Options:
  --dry-run    Print actions without modifying files or LaunchAgents
  --purge      Also remove ~/.gemini/antigravity/anti-claude/studio-prefs.json
  -h, --help   Show this help message
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --purge)
      PURGE=1
      shift
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
  echo "Error: Node.js >= 22 is required to run uninstaller." >&2
  exit 1
fi

SCRIPT_SOURCE="${BASH_SOURCE[0]:-}"
SCRIPT_DIR=""
if [[ -n "$SCRIPT_SOURCE" && -f "$SCRIPT_SOURCE" ]]; then
  SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_SOURCE")" && pwd)"
fi

TARGET_DIR=""
if [[ -n "$SCRIPT_DIR" && -f "$SCRIPT_DIR/studio/cli.mjs" ]]; then
  TARGET_DIR="$SCRIPT_DIR"
elif [[ -f "$PWD/studio/cli.mjs" ]]; then
  TARGET_DIR="$PWD"
elif [[ -f "$INSTALL_DIR/studio/cli.mjs" ]]; then
  TARGET_DIR="$INSTALL_DIR"
else
  echo "Error: Could not find AGY Studio directory. Run from your agy-studio folder." >&2
  exit 1
fi

PREFS_FILE="$HOME/.gemini/antigravity/anti-claude/studio-prefs.json"

if [[ "$DRY_RUN" -eq 1 ]]; then
  echo "[dry-run] node=$NODE_BIN"
  echo "[dry-run] targetDir=$TARGET_DIR"
  echo "[dry-run] exec: \"$NODE_BIN\" studio/cli.mjs rollback && \"$NODE_BIN\" install.mjs uninstall"
  if [[ "$PURGE" -eq 1 ]]; then
    echo "[dry-run] exec: rm -f \"$PREFS_FILE\""
  else
    echo "[dry-run] preserve: \"$PREFS_FILE\""
  fi
  exit 0
fi

cd "$TARGET_DIR"
"$NODE_BIN" studio/cli.mjs rollback
"$NODE_BIN" install.mjs uninstall

if [[ "$PURGE" -eq 1 && -f "$PREFS_FILE" ]]; then
  rm -f "$PREFS_FILE"
  echo "Removed $PREFS_FILE"
fi

echo "AGY Studio uninstalled cleanly. /Applications/Antigravity.app remains untouched."
