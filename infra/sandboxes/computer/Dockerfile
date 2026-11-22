FROM debian:bookworm-slim AS capture-builder
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    libx11-dev \
    libxdamage-dev \
    libxext-dev \
    libxfixes-dev \
    libxtst-dev \
    libpng-dev \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /build
COPY xcapture.c .
RUN cc -O3 -fPIC -shared -Wall -Wextra -Werror -o libtangow-xcapture.so xcapture.c \
    -lX11 -lXext -lXdamage -lXfixes -lXtst -lpng

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    x11vnc \
    fluxbox \
    xfce4-terminal \
    zsh \
    zsh-autosuggestions \
    zsh-syntax-highlighting \
    xdotool \
    x11-utils \
    x11-xserver-utils \
    imagemagick \
    novnc \
    websockify \
    python3 \
    ca-certificates \
    curl \
    jq \
    poppler-utils \
    procps \
    bash \
    fonts-liberation \
    fonts-dejavu-core \
    dbus-x11 \
    xdg-utils \
    libfile-mimeinfo-perl \
    pcmanfm \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    plank \
    dconf-cli \
    gnupg \
  && curl -fsSL https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor -o /usr/share/keyrings/google-chrome.gpg \
  && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome.gpg] https://dl.google.com/linux/chrome/deb/ stable main" \
    > /etc/apt/sources.list.d/google-chrome.list \
  && apt-get update && apt-get install -y --no-install-recommends google-chrome-stable \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --gid 1000 tangow \
  && useradd --uid 1000 --gid tangow --create-home --shell /bin/zsh tangow \
  && mkdir -p /etc/tangow/fluxbox /etc/tangow/plank/dock1/launchers /etc/xdg/xfce4/terminal \
  && rm -f /etc/zsh/newuser.zshrc.recommended \
  && printf '%s\n' '#!/bin/sh' 'exec xsetroot -solid "#111113" "$@"' > /usr/bin/fbsetbg \
  && chmod +x /usr/bin/fbsetbg \
  && ln -sfn /bin/true /usr/bin/xmessage
# Developer tooling so a bot can clone, build, test and open pull requests. gh comes from GitHub's
# signed apt repository and serves as git's credential helper, so a GH_TOKEN in the shell
# environment authenticates both. Node is pinned and checked against its published SHA-256.
ARG NODE_VERSION=22.23.3
ARG NODE_SHA256_AMD64=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
ARG NODE_SHA256_ARM64=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f
RUN set -eu \
  && arch="$(dpkg --print-architecture)" \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
    -o /usr/share/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$arch signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
    > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update && apt-get install -y --no-install-recommends \
    git \
    gh \
    openssh-client \
    build-essential \
    pkg-config \
    python3-dev \
    python3-pip \
    python3-venv \
    ripgrep \
    fd-find \
    file \
    less \
    nano \
    unzip \
    zip \
    xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && ln -sfn /usr/bin/fdfind /usr/local/bin/fd \
  && case "$arch" in \
    amd64) node_arch=x64; node_sha="$NODE_SHA256_AMD64" ;; \
    arm64) node_arch=arm64; node_sha="$NODE_SHA256_ARM64" ;; \
    *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
  esac \
  && node_tar="node-v${NODE_VERSION}-linux-${node_arch}.tar.xz" \
  && curl -fsSLo "/tmp/$node_tar" "https://nodejs.org/dist/v${NODE_VERSION}/$node_tar" \
  && echo "$node_sha  /tmp/$node_tar" | sha256sum -c - \
  && tar -xJf "/tmp/$node_tar" -C /usr/local --strip-components=1 --no-same-owner \
    --exclude=CHANGELOG.md --exclude=LICENSE --exclude=README.md --exclude='share/doc' \
  && rm "/tmp/$node_tar" \
  && corepack enable \
  && git config --system credential.https://github.com.helper '!/usr/bin/gh auth git-credential' \
  && git config --system init.defaultBranch main \
  && node --version && npm --version && git --version && gh --version
# OpenCode, a coding agent available in the computer terminal. Installed under /usr/local so it
# survives the persistent home; start.sh links /managed-skills/computer into its skills directory.
ARG OPENCODE_VERSION=1.18.34
RUN npm install -g "opencode-ai@${OPENCODE_VERSION}" && npm cache clean --force && opencode --version
# Keep the pinned version: the self-updater would otherwise install a newer binary into the persistent home.
ENV OPENCODE_DISABLE_AUTOUPDATE=1
ENV DISPLAY=:1
ENV HOME=/home/tangow
# LibreOffice profile outside the workspace so it never lands in checkpoints.
ENV UserInstallation=file:///tmp/libreoffice-profile
WORKDIR /home/tangow
# --chmod normalizes modes: a restrictive host umask (e.g. 077 on hardened hosts) would
# otherwise leave these files unreadable to USER 1000 at runtime.
COPY --chmod=755 start.sh /usr/local/bin/tangow-computer
COPY --chmod=755 control.py /usr/local/bin/tangow-computer-control
COPY --from=capture-builder /build/libtangow-xcapture.so /usr/local/lib/libtangow-xcapture.so
COPY --chmod=755 tangow-browser /usr/local/bin/tangow-browser
COPY --chmod=755 tangow-page-browser /usr/local/bin/tangow-page-browser
COPY --chmod=755 tangow-terminal /usr/local/bin/tangow-terminal
COPY --chmod=755 tangow-files /usr/local/bin/tangow-files
COPY --chmod=644 terminalrc /etc/xdg/xfce4/terminal/terminalrc
COPY --chmod=644 zshrc /etc/tangow/zshrc
COPY --chmod=644 zshrc /etc/zsh/zshrc
COPY --chmod=644 tangow-browser.desktop /usr/share/applications/tangow-browser.desktop
COPY --chmod=644 tangow-terminal.desktop /usr/share/applications/tangow-terminal.desktop
COPY --chmod=644 tangow-files.desktop /usr/share/applications/tangow-files.desktop
COPY --chmod=644 plank-settings /etc/tangow/plank/dock1/settings
COPY --chmod=644 tangow-browser.dockitem /etc/tangow/plank/dock1/launchers/tangow-browser.dockitem
COPY --chmod=644 tangow-files.dockitem /etc/tangow/plank/dock1/launchers/tangow-files.dockitem
COPY --chmod=644 tangow-terminal.dockitem /etc/tangow/plank/dock1/launchers/tangow-terminal.dockitem
COPY --chmod=644 fluxbox.init /etc/tangow/fluxbox/init
COPY --chmod=644 fluxbox.apps /etc/tangow/fluxbox/apps
COPY --chmod=644 fluxbox.menu /etc/tangow/fluxbox/menu
COPY --chmod=644 libreoffice.xcd /usr/lib/libreoffice/share/registry/tangow.xcd
# Strip CR so shebangs work even if the build context came from a CRLF checkout.
RUN ldconfig \
  && sed -i 's/\r$//' /usr/local/bin/tangow-computer /usr/local/bin/tangow-computer-control /usr/local/bin/tangow-browser /usr/local/bin/tangow-page-browser \
    /usr/local/bin/tangow-terminal /usr/local/bin/tangow-files /etc/tangow/zshrc /etc/xdg/xfce4/terminal/terminalrc \
    /etc/tangow/fluxbox/init /etc/tangow/fluxbox/apps /etc/tangow/fluxbox/menu
EXPOSE 7070 6080 6081 6082 6083 6084 6085 6086 6087 6088 6089 6090 6091 6092 6093 6094 6095
USER 1000:1000
CMD ["/usr/local/bin/tangow-computer"]
