#!/bin/bash
set -e
cd "$(dirname "$0")"

# Auto-bump patch version in package.json
current=$(node -p "require('./package.json').version")
IFS='.' read -r major minor patch <<< "$current"
patch=$((patch + 1))
new_version="$major.$minor.$patch"
node -e "
const fs = require('fs');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '$new_version';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
"
echo "Version: $current → $new_version"

npm run build
npx vsce package --no-dependencies
echo "Done: $(ls *.vsix | tail -1)"
