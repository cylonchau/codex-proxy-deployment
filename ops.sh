#!/usr/bin/env bash
# 一键启动:  ./ops.sh up
# 其他命令:  ./ops.sh <status|logs [服务]|login|down>
# 全新环境只需要本目录的配置文件(compose.yaml、ops.sh、.env.example、codex-api/),不需要任何数据。
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "错误: $*" >&2; exit 1; }
dc() { docker compose "$@"; }
env_get() { { grep -E "^$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2-; }
logged_in() { dc exec -T codex-api codex login status >/dev/null 2>&1; }

init_env() {
  [ -f .env ] && return 0
  command -v openssl >/dev/null || die "需要 openssl 生成随机密钥;或手动把 .env.example 复制为 .env 并填写三个密钥"
  umask 077
  {
    echo "WEBUI_SECRET_KEY=$(openssl rand -hex 32)"
    echo "CODEX_API_KEY=sk-codex-$(openssl rand -hex 24)"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  } > .env
  chmod 600 .env
  echo "已生成 .env(随机密钥,权限 600)"
}

cmd_login() {
  echo "在浏览器打开下面显示的链接,输入验证码,用公司 Team 账号登录。"
  echo "若页面提示未启用设备码登录,需要在 ChatGPT 设置里开启(Team 工作区可能要管理员开启)。"
  dc exec codex-api codex login --device-auth
}

cmd_up() {
  command -v docker >/dev/null || die "没有找到 docker"
  dc version >/dev/null 2>&1 || die "需要 Docker Compose v2(docker compose)"
  init_env
  echo "构建并启动。首次要拉镜像、构建,Open WebUI 首次启动还会下载嵌入模型,可能需要几分钟..."
  dc up -d --build --wait --wait-timeout 900

  local wport aport
  wport="${WEBUI_PORT:-$(env_get WEBUI_PORT)}"; wport="${wport:-3000}"
  aport="${API_PORT:-$(env_get API_PORT)}"; aport="${aport:-8100}"

  if logged_in; then
    echo "Codex 已登录。"
  elif [ -t 0 ] && [ -t 1 ]; then
    echo; echo "Codex 还没有登录,现在开始登录:"
    cmd_login || echo "登录没有完成,之后可以随时运行 ./ops.sh login"
  else
    echo; echo "Codex 还没有登录。请在交互终端运行:  ./ops.sh login"
  fi

  echo
  echo "Open WebUI : http://127.0.0.1:${wport}   (第一个注册的账号是管理员)"
  echo "Codex API  : http://127.0.0.1:${aport}/v1   (密钥见 .env 的 CODEX_API_KEY)"
}

cmd_status() {
  dc ps
  echo "--- Codex 登录 ---"
  dc exec -T codex-api codex login status 2>&1 || true
  echo "--- 服务 ---"
  dc exec -T codex-api node -e "fetch('http://127.0.0.1:8000/health').then(r=>r.text()).then(console.log)" 2>&1 || true
}

case "${1:-}" in
  up) cmd_up ;;
  status) cmd_status ;;
  logs) shift; dc logs -f --tail 100 "$@" ;;
  login) cmd_login ;;
  down) dc down ;;
  *) sed -n '2,4p' "$0"; exit 1 ;;
esac
