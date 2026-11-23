#!/usr/bin/env bash
set -uo pipefail
export DISPLAY="${DISPLAY:-:1}"
export HOME="${HOME:-/home/tangow}"
AGENT_HOME="$HOME"
mkdir -p "$AGENT_HOME" "$AGENT_HOME/.local/bin" "$AGENT_HOME/.config" /tmp/tangow /tmp/.X11-unix /tmp/fluxbox-home
export PATH="$AGENT_HOME/.local/bin:/usr/local/bin:$PATH"
export NPM_CONFIG_PREFIX="$AGENT_HOME/.local"
export PIP_USER=1
cd "$AGENT_HOME"
# The home is a mount, so the image cannot ship ~/.zshrc. Seed one that loads the image defaults;
# it also keeps zsh from opening its first-run wizard. An existing ~/.zshrc is left as is.
[[ -e "$AGENT_HOME/.zshrc" ]] || printf '%s\n' 'source /etc/tangow/zshrc' >"$AGENT_HOME/.zshrc"
# OpenCode reads global skills from ~/.config/opencode/skills/**/SKILL.md and follows symlinks
# (Glob.scan symlink: true), so one link to the read-only mount is enough. A user may replace it
# with a directory of their own; an existing entry is left as is.
mkdir -p "$AGENT_HOME/.config/opencode"
[[ -e "$AGENT_HOME/.config/opencode/skills" || -L "$AGENT_HOME/.config/opencode/skills" ]] \
  || ln -s /managed-skills/computer "$AGENT_HOME/.config/opencode/skills"

if [[ -n "${TANGOW_COMPUTER_CONTROL_TOKEN:-}" ]]; then
  /usr/local/bin/tangow-computer-control >/tmp/tangow/control.log 2>&1 &
fi

rm -f /tmp/.X1-lock /tmp/.X11-unix/X1

Xvfb :1 -screen 0 1280x800x24 -ac +extension RANDR +render -noreset >/tmp/tangow/xvfb.log 2>&1 &
XVFB_PID=$!

ready=0
for _ in $(seq 1 100); do
  if xdpyinfo -display :1 >/dev/null 2>&1; then
    ready=1
    break
  fi
  sleep 0.1
done
if [[ "$ready" -ne 1 ]]; then
  echo "Xvfb failed to start" >&2
  cat /tmp/tangow/xvfb.log >&2 || true
  exit 1
fi

if command -v dbus-launch >/dev/null 2>&1; then
  eval "$(dbus-launch --sh-syntax)"
fi

xsetroot -solid "#111113" >/dev/null 2>&1 || true
mkdir -p /tmp/fluxbox-home/.fluxbox
cp /etc/tangow/fluxbox/init /tmp/fluxbox-home/.fluxbox/init
cp /etc/tangow/fluxbox/apps /tmp/fluxbox-home/.fluxbox/apps 2>/dev/null || true
cp /etc/tangow/fluxbox/menu /tmp/fluxbox-home/.fluxbox/menu 2>/dev/null || true
cat > /tmp/fluxbox-home/.fluxbox/startup <<'EOF'
#!/bin/sh
xsetroot -solid "#111113"
mkdir -p "$HOME/.config/plank/dock1/launchers"
cp /etc/tangow/plank/dock1/settings "$HOME/.config/plank/dock1/settings"
cp /etc/tangow/plank/dock1/launchers/*.dockitem "$HOME/.config/plank/dock1/launchers/"
plank &
exec fluxbox -rc /tmp/fluxbox-home/.fluxbox/init
EOF
chmod +x /tmp/fluxbox-home/.fluxbox/startup
HOME=/tmp/fluxbox-home /tmp/fluxbox-home/.fluxbox/startup >/tmp/tangow/fluxbox.log 2>&1 &

register_browser_handler() {
  local mime="$1"
  if ! xdg-mime default tangow-browser.desktop "$mime" >/dev/null 2>&1 \
    || [[ "$(xdg-mime query default "$mime" 2>/dev/null || true)" != "tangow-browser.desktop" ]]; then
    echo "failed to register tangow-browser for $mime" >&2
    exit 1
  fi
}
register_browser_handler x-scheme-handler/http
register_browser_handler x-scheme-handler/https
register_browser_handler text/html
register_handler() {
  local desktop="$1" mime="$2"
  if [[ ! -f "/usr/share/applications/$desktop" ]] \
    || ! xdg-mime default "$desktop" "$mime" >/dev/null 2>&1 \
    || [[ "$(xdg-mime query default "$mime" 2>/dev/null || true)" != "$desktop" ]]; then
    echo "failed to register $desktop for $mime" >&2
    exit 1
  fi
}
register_handler pcmanfm.desktop inode/directory
for mime in \
  application/vnd.openxmlformats-officedocument.wordprocessingml.document \
  application/msword application/vnd.oasis.opendocument.text application/rtf text/rtf; do
  register_handler libreoffice-writer.desktop "$mime"
done
for mime in \
  application/vnd.openxmlformats-officedocument.spreadsheetml.sheet \
  application/vnd.ms-excel application/vnd.oasis.opendocument.spreadsheet text/csv; do
  register_handler libreoffice-calc.desktop "$mime"
done
for mime in \
  application/vnd.openxmlformats-officedocument.presentationml.presentation \
  application/vnd.ms-powerpoint application/vnd.oasis.opendocument.presentation; do
  register_handler libreoffice-impress.desktop "$mime"
done
if ! xdg-settings set default-web-browser tangow-browser.desktop >/dev/null 2>&1 \
  || [[ "$(xdg-settings get default-web-browser 2>/dev/null || true)" != "tangow-browser.desktop" ]]; then
  echo "failed to set default web browser to tangow-browser" >&2
  exit 1
fi

x11vnc -display :1 -forever -shared -viewonly -nopw -listen 127.0.0.1 -rfbport 5900 -xkb -ncache 0 >/tmp/tangow/x11vnc.log 2>&1 &

NOVNC_ROOT=/usr/share/novnc
if [[ ! -d "$NOVNC_ROOT" ]]; then
  echo "noVNC is missing from the computer image" >&2
  exit 1
fi
websockify --heartbeat=30 --web="$NOVNC_ROOT" --token-plugin=TokenFile --token-source=/tmp/tangow/view-target-1 0.0.0.0:6080 >/tmp/tangow/novnc.log 2>&1 &

while kill -0 "$XVFB_PID" 2>/dev/null; do
  sleep 2
done
echo "Xvfb exited" >&2
exit 1
