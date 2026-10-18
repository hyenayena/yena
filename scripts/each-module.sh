#!/bin/sh
# Runs an npm script in every module that has a package.json.
set -u

script="${1:?usage: each-module.sh <script>}"
failed=0

for d in modules/*/; do
	[ -d "$d" ] || continue
	name="$(basename "$d")"
	if [ ! -f "${d}package.json" ]; then
		echo "skip $name (no package.json)"
		continue
	fi
	echo "== $name: $script =="
	(cd "$d" && npm run --if-present "$script") || failed=1
done

exit "$failed"
