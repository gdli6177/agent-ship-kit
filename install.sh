#!/usr/bin/env bash
# One-command install for agent-ship-kit. No git clone and no sudo.
#   curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash
# Pin a tag:  curl -fsSL .../install.sh | bash -s -- --ref v0.1.0
# Tests can set AGENT_SHIP_TARBALL to a local .tar.gz instead of downloading.
set -euo pipefail

REPO="gdli6177/agent-ship-kit"
DEFAULT_REF="main"
SKILLS=(
  ship-setup
  ship-watchdog
  ship-contract
  ship-dispatch
  ship-inbox
  ship-notify
  ship-e2e
)
SHIM_MARKER="agent-ship-kit-shim"

REF="${AGENT_SHIP_REF:-$DEFAULT_REF}"
KIT_HOME="${AGENT_SHIP_HOME:-$HOME/.agent-ship-kit}"
BIN_DIR="${AGENT_SHIP_BIN_DIR:-$HOME/.local/bin}"
TARGETS=()
AGENTS=()
UNINSTALL=0

usage() {
  cat <<'EOF'
Install agent-ship-kit without cloning.

  curl -fsSL https://raw.githubusercontent.com/gdli6177/agent-ship-kit/main/install.sh | bash

Options:
  --ref <name>     Branch or tag to install (default: main, or AGENT_SHIP_REF).
                   Names may contain letters, numbers, dot, underscore, and hyphen.
  --agent <name>   cursor, claude, codex, or all. Repeatable.
  --target <dir>   Copy skills into this directory instead of detecting agents.
  --uninstall      Remove the shim, this ref's kit directory, and only the
                   skill directories the installer recorded.
  -h, --help       Show this help.

The installer never uses sudo and never edits a project repository.
Re-run the same command to upgrade. Windows: run it inside WSL.
EOF
}

die() {
  echo "error: $*" >&2
  exit 1
}

refuse_windows() {
  local name
  name="$(uname -s 2>/dev/null || echo unknown)"
  case "$name" in
    MINGW*|MSYS*|CYGWIN*)
      die "this installer does not run under Git Bash or MSYS. Install Ubuntu from the Microsoft Store and run the same command inside WSL."
      ;;
  esac
}

valid_ref() {
  [[ "$1" =~ ^[A-Za-z0-9._-]+$ ]]
}

require_node() {
  if ! command -v node >/dev/null 2>&1; then
    die "Node.js 20 or newer is required, and 'node' was not found on PATH. Install it from https://nodejs.org/ and run this again."
  fi
  if ! command -v npm >/dev/null 2>&1; then
    die "npm was not found. It ships with Node.js 20 or newer. Install Node.js and run this again."
  fi
  local major
  if ! major="$(node -p 'process.versions.node.split(".")[0]')"; then
    die "could not read the Node.js version. agent-ship needs Node.js 20 or newer."
  fi
  if [[ ! "$major" =~ ^[0-9]+$ ]] || [[ "$major" -lt 20 ]]; then
    die "Node.js $(node -v 2>/dev/null || echo "$major") is too old. agent-ship needs Node.js 20 or newer."
  fi
}

is_skill_name() {
  local name="$1"
  local skill
  for skill in "${SKILLS[@]}"; do
    [[ "$skill" == "$name" ]] && return 0
  done
  return 1
}

safe_skill_path() {
  local path="$1"
  local base parent
  [[ "$path" == /* ]] || return 1
  case "$path" in
    *"/.."*|*"../"*) return 1 ;;
  esac
  base="$(basename "$path")"
  is_skill_name "$base" || return 1
  parent="$(dirname "$path")"
  [[ "$parent" != "/" && "$parent" != "$HOME" && "$path" != "$HOME" ]] || return 1
  [[ -d "$path" ]] || return 1
  return 0
}

agent_skills_dir() {
  case "$1" in
    cursor) printf '%s\n' "$HOME/.cursor/skills" ;;
    claude) printf '%s\n' "$HOME/.claude/skills" ;;
    codex) printf '%s\n' "$HOME/.codex/skills" ;;
    *) return 1 ;;
  esac
}

abs_dir() {
  mkdir -p "$1"
  (cd "$1" && pwd)
}

detect_targets() {
  local home_dir name dir found=0
  for name in cursor claude codex; do
    home_dir="$HOME/.$name"
    if [[ -d "$home_dir" || -d "$home_dir/skills" ]]; then
      dir="$(abs_dir "$home_dir/skills")"
      TARGETS+=("$dir")
      found=1
    fi
  done
  if [[ "$found" -eq 0 ]]; then
    dir="$(abs_dir "$HOME/.cursor/skills")"
    TARGETS+=("$dir")
    echo "No Cursor, Claude, or Codex home was found. Skills will be copied to $dir." >&2
  fi
}

resolve_targets() {
  local agent dir
  if [[ ${#AGENTS[@]} -eq 0 && ${#TARGETS[@]} -eq 0 ]]; then
    detect_targets
    return
  fi
  local requested=()
  local existing=()
  if [[ ${#TARGETS[@]} -gt 0 ]]; then
    existing=("${TARGETS[@]}")
    TARGETS=()
    for dir in "${existing[@]}"; do
      [[ -n "$dir" ]] || die "--target needs a directory"
      TARGETS+=("$(abs_dir "$dir")")
    done
  fi
  for agent in "${AGENTS[@]}"; do
    if [[ "$agent" == "all" ]]; then
      requested+=(cursor claude codex)
    else
      agent_skills_dir "$agent" >/dev/null || die "--agent must be cursor, claude, codex, or all"
      requested+=("$agent")
    fi
  done
  for agent in "${requested[@]}"; do
    TARGETS+=("$(abs_dir "$(agent_skills_dir "$agent")")")
  done
}

copy_skills() {
  local kit="$1"
  local target name
  INSTALLED_SKILLS=()
  for target in "${TARGETS[@]}"; do
    mkdir -p "$target"
    for name in "${SKILLS[@]}"; do
      [[ -d "$kit/skills/$name" ]] || die "kit is missing skills/$name"
      rm -rf "$target/$name"
      cp -R "$kit/skills/$name" "$target/$name"
      INSTALLED_SKILLS+=("$target/$name")
    done
  done
}

write_shim() {
  local bin_js="$1"
  mkdir -p "$BIN_DIR"
  SHIM_PATH="$BIN_DIR/agent-ship"
  {
    printf '%s\n' "#!/bin/sh"
    printf '%s\n' "# $SHIM_MARKER"
    printf 'exec %q "$@"\n' "$bin_js"
  } >"$SHIM_PATH"
  chmod 755 "$SHIM_PATH"
}

write_manifest() {
  local kit="$1"
  local line
  MANIFEST="$KIT_HOME/manifest"
  {
    printf '%s\n' "# agent-ship-kit-manifest"
    printf 'ref=%s\n' "$REF"
    printf 'kit=%s\n' "$kit"
    printf 'shim=%s\n' "$SHIM_PATH"
    for line in "${INSTALLED_SKILLS[@]}"; do
      printf 'skill=%s\n' "$line"
    done
  } >"$MANIFEST"
}

on_path() {
  case ":$PATH:" in
    *":$BIN_DIR:"*) return 0 ;;
    *) return 1 ;;
  esac
}

unique_targets() {
  local dir seen=""
  local next=()
  for dir in "${TARGETS[@]}"; do
    case " $seen " in
      *" $dir "*) ;;
      *)
        next+=("$dir")
        seen="$seen $dir"
        ;;
    esac
  done
  TARGETS=("${next[@]}")
}

TMP_DIR=""
STAGE_DIR=""
cleanup_install() {
  if [[ -n "$TMP_DIR" ]]; then
    rm -rf "$TMP_DIR"
  fi
  if [[ -n "$STAGE_DIR" && -d "$STAGE_DIR" ]]; then
    rm -rf "$STAGE_DIR"
  fi
}

install_kit() {
  valid_ref "$REF" || die "ref must be a branch or tag without slashes (for example main or v0.1.0)"
  require_node
  command -v tar >/dev/null 2>&1 || die "tar is required"
  trap cleanup_install EXIT
  local extract src dest
  TMP_DIR="$(mktemp -d)"
  extract="$TMP_DIR/extract"
  mkdir -p "$extract"
  if [[ -n "${AGENT_SHIP_TARBALL:-}" ]]; then
    [[ -f "$AGENT_SHIP_TARBALL" ]] || die "AGENT_SHIP_TARBALL is not a file: $AGENT_SHIP_TARBALL"
    echo "Installing agent-ship-kit from $AGENT_SHIP_TARBALL ($REF)"
    tar -xzf "$AGENT_SHIP_TARBALL" -C "$extract"
  else
    command -v curl >/dev/null 2>&1 || die "curl is required"
    local url="https://codeload.github.com/${REPO}/tar.gz/${REF}"
    echo "Downloading agent-ship-kit ($REF)"
    curl -fsSL "$url" | tar -xz -C "$extract"
  fi

  src=""
  if [[ -d "$extract/skills" && -f "$extract/cli/package.json" ]]; then
    src="$extract"
  else
    local candidate
    for candidate in "$extract"/*; do
      if [[ -d "$candidate/skills" && -f "$candidate/cli/package.json" ]]; then
        src="$candidate"
        break
      fi
    done
  fi
  [[ -n "$src" ]] || die "downloaded archive does not look like agent-ship-kit"

  resolve_targets
  [[ ${#TARGETS[@]} -gt 0 ]] || die "no skill directory to install into"
  unique_targets

  dest="$KIT_HOME/$REF"
  STAGE_DIR="$KIT_HOME/.staging-$REF"
  mkdir -p "$KIT_HOME"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  cp -a "$src"/. "$STAGE_DIR"/
  rm -rf "$STAGE_DIR/node_modules" "$STAGE_DIR/cli/node_modules"
  echo "Installing the agent-ship CLI (Node $(node -v))"
  (cd "$STAGE_DIR" && npm install --omit=dev --no-fund --no-audit --loglevel error </dev/null)
  chmod 755 "$STAGE_DIR/cli/bin/agent-ship.js"
  rm -rf "$dest"
  mv "$STAGE_DIR" "$dest"
  STAGE_DIR=""
  rm -rf "$TMP_DIR"
  TMP_DIR=""

  write_shim "$dest/cli/bin/agent-ship.js"
  copy_skills "$dest"
  write_manifest "$dest"

  if ! on_path; then
    echo "warning: $BIN_DIR is not on PATH. Add this to your shell profile:" >&2
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
  fi

  echo
  echo "agent-ship-kit installed"
  echo "  ref:    $REF"
  echo "  kit:    $dest"
  echo "  shim:   $SHIM_PATH"
  local target
  for target in "${TARGETS[@]}"; do
    echo "  skills: $target"
  done
  echo
  echo "Next: open your project and tell the captain /ship-setup"
}

remove_shim() {
  local shim="$1"
  [[ -f "$shim" ]] || return 0
  if grep -q -F "$SHIM_MARKER" "$shim"; then
    rm -f "$shim"
    echo "removed shim $shim"
  else
    echo "warning: left $shim in place because it was not installed by agent-ship-kit" >&2
  fi
}

remove_skill() {
  local path="$1"
  if safe_skill_path "$path"; then
    rm -rf "$path"
    echo "removed skill $path"
    return 0
  fi
  echo "warning: skipped $path (not a skill this installer is allowed to delete)" >&2
  return 0
}

uninstall_kit() {
  valid_ref "$REF" || die "ref must be a branch or tag without slashes"
  local manifest="$KIT_HOME/manifest"
  local kit="$KIT_HOME/$REF"
  local shim="$BIN_DIR/agent-ship"
  local recorded_ref="" recorded_kit="" recorded_shim=""
  local skills=()
  local line skill remove_recorded=0
  if [[ -f "$manifest" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        ref=*) recorded_ref="${line#ref=}" ;;
        kit=*) recorded_kit="${line#kit=}" ;;
        shim=*) recorded_shim="${line#shim=}" ;;
        skill=*) skills+=("${line#skill=}") ;;
      esac
    done <"$manifest"
  fi

  # A plain --uninstall follows the manifest. --ref and AGENT_SHIP_REF stay pinned.
  if [[ -n "$recorded_ref" && "$recorded_ref" != "$REF" && "${UNINSTALL_EXPLICIT_REF:-0}" -eq 0 && -z "${AGENT_SHIP_REF:-}" ]]; then
    REF="$recorded_ref"
    kit="$KIT_HOME/$REF"
  fi

  if [[ -n "$recorded_ref" && "$recorded_ref" == "$REF" ]]; then
    remove_recorded=1
    for skill in "${skills[@]}"; do
      remove_skill "$skill"
    done
    [[ -n "$recorded_shim" ]] && shim="$recorded_shim"
    [[ -n "$recorded_kit" ]] && kit="$recorded_kit"
  elif [[ ! -f "$manifest" ]]; then
    echo "No install manifest found. Removing the shim (if it is ours) and $kit. Skill copies were not removed." >&2
  else
    echo "Manifest records ref $recorded_ref, not $REF. Leaving those skills in place." >&2
  fi

  if [[ "$remove_recorded" -eq 1 || ! -f "$manifest" ]]; then
    remove_shim "$shim"
  elif [[ -f "$shim" ]] && grep -q -F "$SHIM_MARKER" "$shim" && grep -q -F -- "$kit" "$shim"; then
    remove_shim "$shim"
  fi

  case "$kit" in
    "$KIT_HOME"/*)
      if [[ "$(basename "$kit")" == "$REF" && "$kit" != "$KIT_HOME" ]]; then
        rm -rf "$kit"
        echo "removed kit $kit"
        if [[ "$remove_recorded" -eq 1 ]]; then
          rm -f "$manifest"
        fi
      else
        echo "warning: refused to delete $kit" >&2
      fi
      ;;
    *)
      echo "warning: refused to delete $kit" >&2
      ;;
  esac
  rmdir "$KIT_HOME" 2>/dev/null || true
  echo
  echo "agent-ship-kit removed"
  echo
  echo "Next: nothing remains on PATH from this installer. Project repositories were not modified."
}

EXPLICIT_REF=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --ref)
      [[ $# -ge 2 ]] || die "--ref needs a name"
      REF="$2"
      EXPLICIT_REF=1
      shift 2
      ;;
    --target)
      [[ $# -ge 2 ]] || die "--target needs a directory"
      TARGETS+=("$2")
      shift 2
      ;;
    --agent)
      [[ $# -ge 2 ]] || die "--agent needs cursor, claude, codex, or all"
      AGENTS+=("$2")
      shift 2
      ;;
    --uninstall)
      UNINSTALL=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1 (try --help)"
      ;;
  esac
done

refuse_windows
export UNINSTALL_EXPLICIT_REF="$EXPLICIT_REF"

if [[ "$UNINSTALL" -eq 1 ]]; then
  uninstall_kit
else
  install_kit
fi
