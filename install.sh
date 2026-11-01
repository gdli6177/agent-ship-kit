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
                   Slashes are allowed, as in feature/foo. The directory name
                   uses __ in place of /.
  --agent <name>   cursor, claude, codex, or all. Repeatable.
  --target <dir>   Copy skills into this directory instead of detecting agents.
  --uninstall      Remove the shim, the skill directories this installer
                   recorded, and the whole ~/.agent-ship-kit directory
                   (every ref and the current symlink).
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
  local ref="$1" name
  [[ -n "$ref" ]] || return 1
  [[ "$ref" =~ ^[A-Za-z0-9._/-]+$ ]] || return 1
  [[ "$ref" != *..* ]] || return 1
  [[ "$ref" != /* && "$ref" != */ && "$ref" != *//* ]] || return 1
  name="${ref//\//__}"
  [[ -n "$name" && "$name" != "current" && "$name" != "manifest" && "$name" != .* ]] || return 1
  return 0
}

ref_dir_name() {
  printf '%s\n' "${1//\//__}"
}

urlencode() {
  local s="$1" out="" i c hex
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [A-Za-z0-9._~-]) out+="$c" ;;
      *)
        printf -v hex '%%%02X' "'$c"
        out+="$hex"
        ;;
    esac
  done
  printf '%s\n' "$out"
}

codeload_url() {
  printf 'https://codeload.github.com/%s/tar.gz/%s\n' "$REPO" "$(urlencode "$1")"
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
    printf 'dir=%s\n' "$(ref_dir_name "$REF")"
    printf 'kit=%s\n' "$kit"
    printf 'shim=%s\n' "$SHIM_PATH"
    for line in "${INSTALLED_SKILLS[@]}"; do
      printf 'skill=%s\n' "$line"
    done
  } >"$MANIFEST"
}

remove_kit_dir() {
  local kit="$1" base
  [[ -n "$kit" ]] || return 0
  case "$kit" in
    "$KIT_HOME"/*) ;;
    *)
      echo "warning: refused to delete $kit" >&2
      return 0
      ;;
  esac
  case "$kit" in
    *"/.."*|*"../"*)
      echo "warning: refused to delete $kit" >&2
      return 0
      ;;
  esac
  base="$(basename "$kit")"
  [[ "$base" != "current" && "$base" != "manifest" && "$kit" != "$KIT_HOME" ]] || return 0
  if [[ -L "$kit" ]]; then
    echo "warning: refused to delete symlink $kit" >&2
    return 0
  fi
  if [[ -d "$kit" ]]; then
    rm -rf "$kit"
    echo "removed previous kit $kit"
  fi
}

remove_recorded_kits() {
  local keep="$1" manifest="$KIT_HOME/manifest" line kit
  [[ -f "$manifest" ]] || return 0
  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      kit=*)
        kit="${line#kit=}"
        if [[ "$kit" != "$keep" ]]; then
          remove_kit_dir "$kit"
        fi
        ;;
    esac
  done <"$manifest"
}

link_current() {
  local dest="$1" link="$KIT_HOME/current" name
  name="$(basename "$dest")"
  if [[ -e "$link" && ! -L "$link" ]]; then
    die "$link exists and is not a symlink"
  fi
  ln -sfn "$name" "$link"
}

kit_home_is_ours() {
  [[ "$KIT_HOME" == /* ]] || return 1
  [[ "$KIT_HOME" != "/" && "$KIT_HOME" != "$HOME" && "$KIT_HOME" != "$HOME/" ]] || return 1
  case "$KIT_HOME" in
    *"/.."*|*"../"*) return 1 ;;
  esac
  [[ -d "$KIT_HOME" ]] || return 1
  if [[ "$(basename "$KIT_HOME")" == ".agent-ship-kit" ]]; then
    return 0
  fi
  [[ -f "$KIT_HOME/manifest" ]] && grep -q -F "agent-ship-kit-manifest" "$KIT_HOME/manifest"
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
  valid_ref "$REF" || die "ref must be a branch or tag (for example main, v0.1.0, or feature/foo)"
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
    local url
    url="$(codeload_url "$REF")"
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

  local ref_dir
  ref_dir="$(ref_dir_name "$REF")"
  dest="$KIT_HOME/$ref_dir"
  STAGE_DIR="$KIT_HOME/.staging-$ref_dir"
  mkdir -p "$KIT_HOME"
  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"
  cp -a "$src"/. "$STAGE_DIR"/
  rm -rf "$STAGE_DIR/node_modules" "$STAGE_DIR/cli/node_modules"
  echo "Installing the agent-ship CLI (Node $(node -v))"
  (
    cd "$STAGE_DIR" &&
      npm install --omit=dev --no-update-notifier --no-fund --no-audit --silent </dev/null
  ) || die "npm install failed"
  chmod 755 "$STAGE_DIR/cli/bin/agent-ship.js"
  rm -rf "$dest"
  mv "$STAGE_DIR" "$dest"
  STAGE_DIR=""
  rm -rf "$TMP_DIR"
  TMP_DIR=""

  remove_recorded_kits "$dest"
  link_current "$dest"
  write_shim "$KIT_HOME/current/cli/bin/agent-ship.js"
  copy_skills "$KIT_HOME/current"
  write_manifest "$dest"

  if ! on_path; then
    echo "warning: $BIN_DIR is not on PATH. Add this to your shell profile:" >&2
    echo "  export PATH=\"\$HOME/.local/bin:\$PATH\"" >&2
  fi

  echo
  echo "agent-ship-kit installed"
  echo "  ref:     $REF"
  echo "  kit:     $dest"
  echo "  current: $KIT_HOME/current"
  echo "  shim:    $SHIM_PATH"
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
  local manifest="$KIT_HOME/manifest"
  local shim="$BIN_DIR/agent-ship"
  local skills=()
  local line skill
  if [[ -f "$manifest" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        shim=*) shim="${line#shim=}" ;;
        skill=*) skills+=("${line#skill=}") ;;
      esac
    done <"$manifest"
  else
    echo "No install manifest found. Removing the shim (if it is ours) and $KIT_HOME." >&2
  fi
  if [[ ${#skills[@]} -gt 0 ]]; then
    for skill in "${skills[@]}"; do
      remove_skill "$skill"
    done
  fi
  remove_shim "$shim"
  if kit_home_is_ours; then
    rm -rf "$KIT_HOME"
    echo "removed $KIT_HOME"
  elif [[ -e "$KIT_HOME" ]]; then
    echo "warning: refused to delete $KIT_HOME" >&2
  fi
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
