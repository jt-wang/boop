#!/bin/sh
# Install the assistant's browser inside the container, on demand.
# The image ships without Chromium (it is 450 MB with fonts); the assistant runs
# this through its install_browser tool the first time it needs the browser; the
# bot runs it (the agent's own shell is sandboxed; src/browser-install.ts) and
# then starts the browser and adds its tools to the profile patch (src/main.ts).
#
# One install at a time: a second run waits for the first one's lock, then finds
# the browser there. apt and dpkg also wait for their own locks instead of
# failing, and
# an install cut short by a restart is finished first (dpkg --configure -a).
# "step: …" lines are what the bot tells the assistant while it runs.
set -eu
EXE="${DEEPSEEK_BOT_BROWSER_EXECUTABLE:-/usr/bin/chromium}"
LOCK="${DEEPSEEK_BOT_BROWSER_LOCK:-/run/lock/deepseek-bot-browser-install.lock}"
mkdir -p "$(dirname "$LOCK")"
exec 9>"$LOCK"
if ! flock -n 9; then
  echo "step: waiting for the install that is already running"
  flock -w 1200 9
fi
if [ -x "$EXE" ]; then
  echo "browser already installed at $EXE"
  exit 0
fi
export DEBIAN_FRONTEND=noninteractive
APT="apt-get -q -o DPkg::Lock::Timeout=300"
echo "step: getting ready"
dpkg --configure -a
echo "step: fetching the package list"
$APT update
echo "step: downloading and setting up the browser (about 450 MB)"
$APT install -y --no-install-recommends chromium fonts-noto-cjk
rm -rf /var/lib/apt/lists/*
echo "installed $EXE"
