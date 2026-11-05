# The host service image: the slim bot image plus the Docker CLI, so the host
# can create one sandbox container per account through the daemon's socket.
# Build the base first: docker build -t deepseek-bot:slim .
FROM deepseek-bot:slim
RUN apt-get update && apt-get install -y --no-install-recommends gnupg \
    && install -m 0755 -d /etc/apt/keyrings \
    && curl -fsSL https://download.docker.com/linux/debian/gpg -o /etc/apt/keyrings/docker.asc \
    && echo "deb [signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/debian $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list \
    && apt-get update && apt-get install -y --no-install-recommends docker-ce-cli \
    && apt-get purge -y gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
ENV DEEPSEEK_BOT_HOST_HOME=/host-data
VOLUME ["/host-data"]
EXPOSE 3860
HEALTHCHECK --interval=30s --timeout=5s CMD curl -fsS http://127.0.0.1:3860/host/health || exit 1
CMD ["node", "src/host-main.ts", "--host", "0.0.0.0", "--port", "3860"]
