# Squall Uno's desktop: a small Linux computer with a 1280x800 screen, a taskbar, a terminal and Firefox.
# Squall builds it as squall-uno-desktop:1 the first time an agent's computer starts (see docs/squall-uno.md).
FROM debian:bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    LC_ALL=C.UTF-8

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      xvfb xdotool imagemagick openbox tint2 xterm firefox-esr \
      fonts-dejavu fonts-noto-color-emoji x11-utils ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Firefox: no first-run tabs, no telemetry, never offers to save passwords.
COPY policies.json /usr/lib/firefox-esr/distribution/policies.json
COPY start.sh /usr/local/bin/squall-uno-start
RUN chmod 644 /usr/lib/firefox-esr/distribution/policies.json \
 && chmod 755 /usr/local/bin/squall-uno-start \
 && useradd --create-home --shell /bin/bash uno

USER uno
WORKDIR /home/uno
ENV DISPLAY=:1

CMD ["/usr/local/bin/squall-uno-start"]
