#!/bin/sh
# macOS and Linux: install the dependencies once, then start Nexus from the sources.
cd "$(dirname "$0")" || exit 1
[ -d node_modules ] || npm install || exit 1
exec npm start
