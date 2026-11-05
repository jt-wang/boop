# The assistant's computer: the bot service + DeepSeek Harness in one image.
# Data (memory files, sessions, paired phones, browser logins) lives in the /data volume.
#
# No Chromium in the image: the assistant installs it the first time it needs a
# browser (scripts/install-browser.sh, apt, ~450 MB more). Measured 2026-10-27
# on arm64 (Docker 29.8.2): this image 613 MB (687 MB before the SDK prune); the earlier one with Chromium + CJK fonts 1.78 GB.
# linux/amd64 (Fly's), measured 2026-10-29 with OrbStack: 645 MB on bookworm; 686 MB on trixie with
# TypeScript 7 for nsh (+28 MB TypeScript, +8 MB packages, +4 MB base); 705 MB with sharp's native build kept
# for read_image (arm64: 638 → 657 MB).

# Stage 1: dependencies, pruned. The optional native packages below belong to
# DSH's experimental speech-to-text and office-to-pdf packages, which the web
# profile does not load; together with the npm cache they were 320 MB. The
# second line removes SDKs DSH's dependency tree carries but no model the bot
# can be pointed at loads (AWS Bedrock, GitHub, Google, Anthropic,
# OpenTelemetry). `openai` stays: DSH's adapter for the DeepSeek API and every
# OpenAI-compatible gateway imports it. sharp's native build for this platform
# stays too (node_modules/@img/sharp-linux-*, installed from the lockfile at
# build time; nothing is downloaded at run time): DSH's read_image stores every
# image through it. With @img pruned, every read_image on the hosted computer
# failed with "Could not load the sharp module". Both
# are guarded by test/image.test.ts. Only sharp's WebAssembly fallback goes.
FROM node:24-trixie-slim AS deps
WORKDIR /opt/deepseek-bot
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && rm -rf node_modules/@deepseek-ai/libreoffice-kit-wasm node_modules/@deepseek-ai/libreoffice-kit-*-* \
              node_modules/sherpa-onnx-* node_modules/@img/sharp-wasm32 \
              node_modules/@aws-sdk node_modules/@smithy node_modules/@octokit node_modules/@google node_modules/@anthropic-ai \
              node_modules/@opentelemetry \
    && npm cache clean --force

# Stage 2: the runtime. Debian 13 (trixie, glibc 2.41): the nsh 0.3.0 Linux
# build needs glibc 2.39; on bookworm (2.36) every nsh call printed "weak
# version `GLIBC_2.39' not found" into the ui tool's errors.
FROM node:24-trixie-slim
# iptables: kernel owner-match egress rules for the cell uid. e2fsprogs: the
# fixed-size workspace image. util-linux: mount/umount/setpriv/prlimit.
# WITH_BROWSER=1 is used by the containment test; production installs Chromium
# on demand (scripts/install-browser.sh). fonts-wqy-microhei: Latin and CJK
# letters for the charts the assistant draws (5 MB; below); fontconfig-config: its
# /etc/fonts/fonts.conf, without which every chart prints a Fontconfig error.
ARG WITH_BROWSER=0
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates git curl bubblewrap python3 iptables nftables e2fsprogs util-linux \
      fonts-wqy-microhei fontconfig-config \
    && if [ "$WITH_BROWSER" = "1" ]; then apt-get install -y --no-install-recommends chromium fonts-noto-cjk; fi \
    && rm -rf /var/lib/apt/lists/*

# The browser broker runs as its own unprivileged user, never uid 1000 (the
# cell) and never root. Its profile lives under /data but outside the cell.
RUN groupadd --system --gid 1001 browser \
    && useradd --system --uid 1001 --gid 1001 --no-create-home --shell /usr/sbin/nologin browser

# Chromium enterprise policy: file:// and chrome:// are refused by the browser
# itself, not by custom page checks. Both the Debian Chromium and Google Chrome
# policy directories are populated.
RUN mkdir -p /etc/chromium/policies/managed /etc/opt/chrome/policies/managed
COPY deploy/chromium-policy.json /etc/chromium/policies/managed/deepseek-bot.json
RUN cp /etc/chromium/policies/managed/deepseek-bot.json /etc/opt/chrome/policies/managed/deepseek-bot.json

# The nsh CLI (0.3.0) signs the interfaces the assistant writes (src/ui.ts). Only
# x86_64 has a Linux release (https://nsh.dev/docs/installation: "Linux arm64 …
# No prebuilt release exists", checked 2026-10-27 against the v0.3.0 assets); on
# arm64 the image has no nsh and the `ui` tool tells the assistant to use `show`.
# Tarball sha256 recorded from nsh-linux-x86_64.tar.gz.sha256 on 2026-10-27.
#
# `nsh check` type-checks with TypeScript 7's native compiler, which nsh
# downloads from registry.npmjs.org into $HOME on first use. The compiler runs
# as uid 1000 with a minimal environment and a fresh HOME per module, and uid
# 1000 may not open connections except through the bot's proxy, so on the
# hosted computer every check failed ("download … typescript-linux-x64-7.0.2.tgz:
# Network is unreachable"). The image ships the exact package nsh
# 0.3.0 pins (its sha512 is the one in the nsh binary and in the npm registry)
# and NSH_TSC names it; the build fails if nsh warns about the C library or
# if a check still downloads anything.
ARG TARGETARCH
RUN if [ "$TARGETARCH" = "amd64" ]; then \
      curl -fsSL -o /tmp/nsh.tar.gz https://github.com/longbridge/nsh/releases/download/v0.3.0/nsh-linux-x86_64.tar.gz \
      && echo "539ecf9d76d156b5afa5a086212f23764bfc3945c7395a2119b73a3c66effed0  /tmp/nsh.tar.gz" | sha256sum -c - \
      && mkdir -p /opt/nsh && tar -xzf /tmp/nsh.tar.gz -C /opt/nsh --strip-components=1 nsh/bin nsh/LICENSE-APACHE \
      && ln -s /opt/nsh/bin/nsh /usr/local/bin/nsh && rm /tmp/nsh.tar.gz \
      && curl -fsSL -o /tmp/tsc.tgz https://registry.npmjs.org/@typescript/typescript-linux-x64/-/typescript-linux-x64-7.0.2.tgz \
      && echo "11875fd9c360eeb8025899f109d27e177577f4ef2285bdfb78702ed4b2bca00162ce04d06cf38aef31c75db3edf2b5f6e023aa3835de237b087f47c25c6ec7fc  /tmp/tsc.tgz" | sha512sum -c - \
      && mkdir -p /opt/nsh/typescript && tar -xzf /tmp/tsc.tgz -C /opt/nsh/typescript --strip-components=1 package/lib package/package.json package/LICENSE package/NOTICE.txt \
      && rm /tmp/tsc.tgz \
      && v="$(nsh --version 2>&1)" && echo "$v" && if echo "$v" | grep -q GLIBC; then exit 1; fi \
      && mkdir /tmp/c && printf "import { mount, Text } from 'nsh'\nfunction App() { return <Text>ok</Text> }\nmount(App)\n" > /tmp/c/App.tsx \
      && printf '{"name":"c","id":"dev.deepseekbot.ui.c","version":"1.0.0","build":1}' > /tmp/c/nsh.json \
      && printf '{"extends":"./.nsh/tsconfig.json","include":["App.tsx"]}' > /tmp/c/tsconfig.json \
      && env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp/c NSH_TSC=/opt/nsh/typescript/lib/tsc nsh check /tmp/c \
      && test ! -e /tmp/c/.cache && rm -rf /tmp/c; \
    else echo "no nsh release for $TARGETARCH: the ui tool is off in this image"; fi

WORKDIR /opt/deepseek-bot
COPY --from=deps /opt/deepseek-bot/node_modules ./node_modules
# The build fails unless sharp loads and resizes an image as uid 1000, the uid DSH runs as in the cell, the way
# read_image's attachment store uses it.
RUN setpriv --reuid=1000 --regid=1000 --clear-groups -- env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp \
      node --input-type=module -e "import sharp from 'sharp'; const png = await sharp({ create: { width: 64, height: 48, channels: 3, background: '#3366cc' } }).png().toBuffer(); const out = await sharp(png).resize(32).webp().toBuffer({ resolveWithObject: true }); if (out.info.width !== 32) throw new Error('sharp did not resize'); console.log('sharp', sharp.versions.sharp, 'libvips', sharp.versions.vips)"
# A chart is a Node script: `echarts` renders it to SVG (ssr) and `sharp` makes
# the PNG. /node_modules is where Node looks last from any folder, so a script in
# the workspace imports both by name, as the cell user, with no npm install
#.
RUN mkdir /node_modules && ln -s /opt/deepseek-bot/node_modules/echarts /opt/deepseek-bot/node_modules/sharp /node_modules/
# `chart option.json out.png`: the same in one command, which exits by itself.
COPY scripts/chart.mjs /usr/local/bin/chart
RUN chmod 755 /usr/local/bin/chart
COPY package.json ./
COPY src ./src
COPY app ./app
COPY bin ./bin
COPY scripts ./scripts
COPY README.md SETUP.md ./

ENV DEEPSEEK_BOT_HOME=/data \
    NSH_BIN=/usr/local/bin/nsh \
    NSH_TSC=/opt/nsh/typescript/lib/tsc \
    DEEPSEEK_BOT_BROWSER_EXECUTABLE=/usr/bin/chromium \
    DEEPSEEK_BOT_IN_CONTAINER=1 \
    DEEPSEEK_BOT_SUPERVISED=1 \
    NODE_ENV=production
VOLUME ["/data"]
EXPOSE 3850
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fsS http://127.0.0.1:3850/health || exit 1

# Bind to every interface, v4 and v6, inside the container: Docker publishes or proxies 3850 over v4;
# Fly reaches a machine over its private IPv6 only (measured 2026-10-27: with 0.0.0.0 the machine
# answered on 127.0.0.1 and not on its fdaa:: address).
CMD ["node", "src/main.ts", "--host", "::", "--port", "3850"]
