#!/usr/bin/env bash
while true; do
  /workspace/paper-trader/keepalive.sh || true
  sleep 300
done
