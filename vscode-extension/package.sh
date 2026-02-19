#!/bin/bash
set -e
cd "$(dirname "$0")"
npm run build
npx vsce package --no-dependencies
echo "Done: $(ls *.vsix | tail -1)"
