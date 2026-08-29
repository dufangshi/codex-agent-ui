#!/bin/sh
set -eu

# Apple Container exposes a mounted macOS home at /Users/<name>. Reuse its
# harness state without copying credentials into the machine image.
HOST_HOME="${TREER_HOST_HOME:-}"
if [ -z "$HOST_HOME" ] && [ -d "/Users/$(id -un)" ]; then
  HOST_HOME="/Users/$(id -un)"
fi
if [ -z "$HOST_HOME" ] || [ ! -d "$HOST_HOME" ] || [ "$HOST_HOME" = "$HOME" ]; then
  exit 0
fi

link_dir() {
  source="$HOST_HOME/$1"
  target="$HOME/$1"
  [ -d "$source" ] || return 0
  mkdir -p "$(dirname "$target")"
  if [ -L "$target" ]; then
    [ "$(readlink "$target")" = "$source" ] && return 0
    rm "$target"
  elif [ -e "$target" ]; then
    echo "keeping local harness state at $target (host state remains at $source)" >&2
    return 0
  fi
  ln -s "$source" "$target"
  echo "mapped harness state $target -> $source"
}

link_file() {
  source="$HOST_HOME/$1"
  target="$HOME/$1"
  [ -e "$source" ] || return 0
  mkdir -p "$(dirname "$target")"
  if [ -L "$target" ]; then
    [ "$(readlink "$target")" = "$source" ] && return 0
    rm "$target"
  elif [ -e "$target" ]; then
    echo "keeping local harness file at $target (host file remains at $source)" >&2
    return 0
  fi
  ln -s "$source" "$target"
  echo "mapped harness file $target -> $source"
}

link_dir .codex
link_dir .claude
link_file .claude.json
link_dir .cursor
link_dir .pi
link_dir .config/opencode
link_dir .local/share/opencode

# Grok installs platform-specific binaries below ~/.grok/bin. Only share its
# portable auth/config files so a macOS binary is never executed in Linux.
link_file .grok/auth.json
link_file .grok/config.toml
link_file .grok/env
