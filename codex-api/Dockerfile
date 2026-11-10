# syntax=docker/dockerfile:1
# 基础镜像按摘要固定(node 22.23.4, bookworm-slim)。升级时同时改摘要并跑 README 里的验证清单。
FROM node:22-bookworm-slim@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d

# 聊天桥依赖 Codex 的 JSONL 事件格式和会话记录格式,所以 Codex 版本必须固定,升级前先测。
ARG CODEX_VERSION=0.167.0

RUN apt-get update \
    && apt-get install -y --no-install-recommends git ca-certificates ripgrep tini \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g "@openai/codex@${CODEX_VERSION}" \
    && codex --version | grep -F "${CODEX_VERSION}" \
    && npm cache clean --force

COPY server.mjs /opt/codex-api/server.mjs

# 非 root 运行:登录令牌在 /home/node/.codex(挂载卷),工作目录在 /workspace(挂载卷)
ENV HOME=/home/node \
    CODEX_HOME=/home/node/.codex \
    CODEX_WORKDIR=/workspace \
    PORT=8000

RUN mkdir -p /workspace /home/node/.codex && chown -R node:node /workspace /home/node
USER node
WORKDIR /workspace
EXPOSE 8000

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:8000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/codex-api/server.mjs"]
