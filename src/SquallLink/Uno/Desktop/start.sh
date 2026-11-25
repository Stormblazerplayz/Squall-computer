#!/bin/bash
# Starts Squall Uno's desktop inside the container: the X screen :1 (1280x800), the openbox window manager,
# the tint2 taskbar and Firefox. The container lives as long as the X screen does.

# A container that was stopped and started again still has the old screen's lock files.
rm -f /tmp/.X1-lock /tmp/.X11-unix/X1

Xvfb :1 -screen 0 1280x800x24 -nolisten tcp -noreset -ac &
XVFB=$!

export DISPLAY=:1
for _ in $(seq 1 100); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then break; fi
  sleep 0.1
done

openbox >/dev/null 2>&1 &
tint2 >/dev/null 2>&1 &
firefox-esr --new-instance about:blank >/dev/null 2>&1 &

wait "$XVFB"
