#!/bin/sh
set -eu

template="/usr/share/nginx/html/runtime-config.template.js"
output="/usr/share/nginx/html/runtime-config.js"
colyseus_url="${VITE_COLYSEUS_URL:-ws://localhost:2567}"

escaped_colyseus_url=$(printf '%s' "$colyseus_url" | sed 's/[\/&]/\\&/g')
sed "s|__VITE_COLYSEUS_URL__|$escaped_colyseus_url|g" "$template" > "$output"
