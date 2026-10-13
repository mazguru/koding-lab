#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null)" || {
  echo "Error: jalankan skrip ini dari dalam folder repository Git." >&2
  exit 1
}
cd "$repo_root"

branch="$(git branch --show-current)"
if [[ -z "$branch" ]]; then
  echo "Error: repository sedang berada dalam detached HEAD." >&2
  exit 1
fi

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "Error: remote 'origin' belum dikonfigurasi." >&2
  exit 1
fi

commit_message="${1:-}"
if [[ -z "$commit_message" ]]; then
  read -r -p "Pesan commit: " commit_message
fi

if [[ -z "${commit_message//[[:space:]]/}" ]]; then
  echo "Error: pesan commit tidak boleh kosong." >&2
  exit 1
fi

git add -A

if git diff --cached --quiet; then
  echo "Tidak ada perubahan untuk di-commit."
  exit 0
fi

git commit -m "$commit_message"
git push --set-upstream origin "$branch"