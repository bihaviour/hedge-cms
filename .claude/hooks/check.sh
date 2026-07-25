#!/usr/bin/env bash
#
# PostToolUse hook: format + lint the file that was just written with Biome, then typecheck the
# workspace that owns it. Wired up in .claude/settings.json for Write|Edit.
#
# Exit codes matter here: 0 is silent success, 2 is a blocking error whose stdout is fed back to
# Claude. Anything Biome can fix, it fixes; what is left — real lint violations and type errors —
# comes back as text so the mistake is caught at the edit that caused it rather than in CI.
#
# Reads the hook payload as JSON on stdin.

set -uo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)

file=$(jq -r '.tool_response.filePath // .tool_input.file_path // empty' 2>/dev/null)
[ -n "$file" ] || exit 0

# Only files Biome and tsc actually handle.
case "$file" in
  *.ts | *.tsx | *.js | *.jsx | *.mjs | *.cjs | *.json | *.jsonc | *.css) ;;
  *) exit 0 ;;
esac

# Only files inside this repository, and never generated or vendored ones. Biome has its own
# ignore list in biome.json; this keeps tsc from being run over the same paths.
case "$file" in
  "$root"/*) ;;
  *) exit 0 ;;
esac
case "$file" in
  */node_modules/* | */dist/* | */.wrangler/* | *worker-configuration.d.ts) exit 0 ;;
esac

cd "$root" || exit 0

failures=""

# Formats and applies safe fixes in place; exits non-zero only for what it could not fix.
if ! lint_output=$(bunx biome check --write "$file" 2>&1); then
  failures+="Biome found problems it could not fix automatically:"$'\n'"$lint_output"$'\n'
fi

# Typecheck just the workspace that owns the file — the whole monorepo on every edit is too slow
# to be useful, and a type error is almost always local to the package being edited.
relative=${file#"$root"/}
workspace=""
case "$relative" in
  apps/api/*) workspace="apps/api" ;;
  apps/admin/*) workspace="apps/admin" ;;
  packages/core/*) workspace="packages/core" ;;
esac

if [ -n "$workspace" ]; then
  if ! type_output=$(bun run --cwd "$workspace" typecheck 2>&1); then
    failures+="Typecheck failed in $workspace:"$'\n'"$type_output"$'\n'
  fi
fi

if [ -n "$failures" ]; then
  printf '%s' "$failures" | head -60
  exit 2
fi

exit 0
