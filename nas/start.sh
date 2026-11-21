#!/bin/sh
set -eu
cd "$(dirname "$0")"
if docker compose version >/dev/null 2>&1; then
  docker compose up -d
  docker compose ps production-board
else
  docker-compose up -d
  docker-compose ps production-board
fi
