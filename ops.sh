#!/usr/bin/env bash
# 一键启动:  ./ops.sh up
# 其他命令:  ./ops.sh <init|status|logs [服务]|login|cert|psql|compose <参数>|down>
#            init 只生成 .env(随机密钥)不启动,方便先编辑再 up
# 数据库:.env 里 DATABASE_URL 为空 → 自动起内置 Postgres;填了 → 连外部 Postgres。
# 访问:  .env 里 HTTPS=true → nginx 监听 80/443,用 certs/ 里你买的证书;否则 Open WebUI 直接监听 WEBUI_PORT。
# 全新环境只需要本目录的配置文件(compose*.yaml、ops.sh、.env.example、codex-api/、nginx/、postgres/、certs/README.md),不需要任何数据。
set -euo pipefail
cd "$(dirname "$0")"

die() { echo "错误: $*" >&2; exit 1; }
env_get() { { grep -E "^$1=" .env 2>/dev/null || true; } | tail -1 | cut -d= -f2- | sed 's/[[:space:]]*#.*$//; s/[[:space:]]*$//'; }
is_true() { case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in true|on|yes|1) return 0 ;; *) return 1 ;; esac; }

COMPOSE_ARGS=(-f compose.yaml)
DB_MODE=
ACCESS=
dc() { docker compose "${COMPOSE_ARGS[@]}" "$@"; }
logged_in() { dc exec -T codex-api codex login status >/dev/null 2>&1; }

# 按 .env 决定叠加哪些 compose 文件。必须先有 .env。
setup_stack() {
  [ -f .env ] || die "没有 .env。先运行 ./ops.sh up,或把 .env.example 复制为 .env 并填写"
  COMPOSE_ARGS=(-f compose.yaml)

  # 数据库
  if [ -n "$(env_get DATABASE_URL)" ]; then
    DB_MODE=external            # 地址由 compose 直接从 .env 读取
  else
    DB_MODE=bundled
    local pw; pw="$(env_get POSTGRES_PASSWORD)"
    [ -n "$pw" ] || die ".env 里没有 POSTGRES_PASSWORD(内置库需要);或者填 DATABASE_URL 改用外部库"
    COMPOSE_ARGS+=(-f compose.db.yaml)
    export DATABASE_URL="postgresql://openwebui:${pw}@postgres:5432/openwebui"
  fi

  # 访问方式
  if is_true "$(env_get HTTPS)"; then
    ACCESS=https; COMPOSE_ARGS+=(-f compose.tls.yaml)
  else
    ACCESS=plain; COMPOSE_ARGS+=(-f compose.plain.yaml)
  fi
}

# 只显示数据库主机,不显示账号密码。
db_host() { env_get DATABASE_URL | sed -E 's#^[a-zA-Z0-9+]+://([^@/]*@)?([^/?]+).*#\2#'; }
db_label() {
  if [ "$DB_MODE" = external ]; then echo "外部 Postgres($(db_host))"; else echo "内置 Postgres(自动启动)"; fi
}
access_label() {
  if [ "$ACCESS" = https ]; then echo "HTTPS(nginx 监听 ${HTTP_PORT_V}/${HTTPS_PORT_V},证书目录 $(cert_dir))"; else echo "HTTP 直连(端口 ${WEBUI_PORT_V})"; fi
}
cert_dir() { local d; d="$(env_get CERT_DIR)"; echo "${d:-./certs}"; }

# 端口取值:shell 环境变量优先,再取 .env,最后默认值
load_ports() {
  WEBUI_PORT_V="${WEBUI_PORT:-$(env_get WEBUI_PORT)}"; WEBUI_PORT_V="${WEBUI_PORT_V:-3000}"
  API_PORT_V="${API_PORT:-$(env_get API_PORT)}"; API_PORT_V="${API_PORT_V:-8100}"
  HTTP_PORT_V="${HTTP_PORT:-$(env_get HTTP_PORT)}"; HTTP_PORT_V="${HTTP_PORT_V:-80}"
  HTTPS_PORT_V="${HTTPS_PORT:-$(env_get HTTPS_PORT)}"; HTTPS_PORT_V="${HTTPS_PORT_V:-443}"
}

# 启动前检查证书:文件在、是 PEM、私钥匹配、没过期。有问题就在这里说清楚,而不是等 nginx 起不来。
check_cert() {
  local dir crt key
  dir="$(cert_dir)"; crt="$dir/fullchain.pem"; key="$dir/privkey.pem"
  [ -f "$crt" ] || die "HTTPS=true,但找不到证书文件 $crt。把证书(服务器证书 + 中间证书链)放成这个名字,见 certs/README.md"
  [ -f "$key" ] || die "HTTPS=true,但找不到私钥文件 $key。见 certs/README.md"
  command -v openssl >/dev/null || { echo "提示: 没有 openssl,跳过证书检查"; return 0; }

  openssl x509 -in "$crt" -noout >/dev/null 2>&1 \
    || die "$crt 不是有效的 PEM 证书(需要 PEM 文本格式,不能是 .pfx / .der;转换方法见 certs/README.md)"
  local cert_pub key_pub
  cert_pub="$(openssl x509 -in "$crt" -noout -pubkey 2>/dev/null | openssl sha256)"
  key_pub="$(openssl pkey -in "$key" -pubout -passin pass: 2>/dev/null | openssl sha256)" || true
  openssl pkey -in "$key" -noout -passin pass: >/dev/null 2>&1 \
    || die "读不了私钥 $key。可能不是 PEM 格式,或者私钥有密码保护(nginx 不能直接用,需要先去掉密码,见 certs/README.md)"
  [ "$cert_pub" = "$key_pub" ] \
    || die "私钥和证书不匹配($key 不是 $crt 的私钥)。注意 fullchain.pem 里服务器证书要排在第一张"
  openssl x509 -in "$crt" -noout -checkend 0 >/dev/null 2>&1 || die "证书已经过期"
  if ! openssl x509 -in "$crt" -noout -checkend $((30 * 86400)) >/dev/null 2>&1; then
    echo "警告: 证书将在 30 天内到期,到期前换新证书后运行 ./ops.sh cert"
  fi
  if [ "$(grep -c 'BEGIN CERTIFICATE' "$crt")" -lt 2 ]; then
    echo "警告: $crt 里只有一张证书,没有中间证书链。部分浏览器或客户端会报“证书不受信任”;买证书时给的 ca-bundle 要拼在服务器证书后面"
  fi
  echo "证书: $(openssl x509 -in "$crt" -noout -subject | sed 's/^subject= *//'),$(openssl x509 -in "$crt" -noout -enddate | sed 's/^notAfter=/到期 /')"
}

init_env() {
  [ -f .env ] && return 0
  command -v openssl >/dev/null || die "需要 openssl 生成随机密钥;或手动把 .env.example 复制为 .env 并填写"
  umask 077
  {
    echo "WEBUI_SECRET_KEY=$(openssl rand -hex 32)"
    echo "CODEX_API_KEY=sk-codex-$(openssl rand -hex 24)"
    echo "POSTGRES_PASSWORD=$(openssl rand -hex 24)"
  } > .env
  chmod 600 .env
  echo "已生成 .env(随机密钥,权限 600)。默认:内置 Postgres + HTTP 直连 127.0.0.1:3000。"
  echo "要连外部库,填 DATABASE_URL;要用 80/443 和自己的证书,填 HTTPS=true 并放好证书(见 README),然后重新运行 ./ops.sh up"
}

cmd_login() {
  echo "账号不支持设备码登录时用这个方式(标准浏览器 URL 登录):"
  echo "1) 先在你自己电脑上开一个新终端,建立隧道(不要关,保持这个终端开着):"
  echo "     ssh -L 1455:127.0.0.1:1455 -L 1457:127.0.0.1:1457 <用户名>@<这台服务器地址>"
  echo "2) 隧道建好后,回到这边继续,下面会打印一个链接;在你自己电脑的浏览器里打开它并登录。"
  echo "   (如果账号支持设备码登录,改跑: ./ops.sh compose exec codex-api codex login --device-auth)"
  echo
  dc exec codex-api codex login
}

cmd_up() {
  command -v docker >/dev/null || die "没有找到 docker"
  docker compose version >/dev/null 2>&1 || die "需要 Docker Compose v2(docker compose)"
  init_env
  setup_stack
  load_ports
  echo "数据库: $(db_label)"
  echo "访问  : $(access_label)"
  [ "$ACCESS" = https ] && check_cert
  echo "构建并启动。首次要拉镜像、构建,Open WebUI 首次启动还会下载嵌入模型,可能需要几分钟..."
  # --remove-orphans:从内置库切到外部库(或开关 HTTPS)后,不再需要的容器会被移除(数据卷不会删)
  if ! dc up -d --build --wait --wait-timeout 900 --remove-orphans; then
    echo >&2
    echo "启动失败。看哪个服务不健康:  ./ops.sh status    日志:  ./ops.sh logs openwebui" >&2
    [ "$DB_MODE" = external ] && echo "用外部数据库时,检查 DATABASE_URL 是否可达,库和账号是否已按 postgres/init.sql 建好。" >&2
    [ "$ACCESS" = https ] && echo "HTTPS 模式下也看看代理:  ./ops.sh logs proxy(80/443 端口是否被别的程序占用?)" >&2
    exit 1
  fi

  if logged_in; then
    echo "Codex 已登录。"
  elif [ -t 0 ] && [ -t 1 ]; then
    echo; echo "Codex 还没有登录,现在开始登录:"
    cmd_login || echo "登录没有完成,之后可以随时运行 ./ops.sh login"
  else
    echo; echo "Codex 还没有登录。请在交互终端运行:  ./ops.sh login"
  fi

  echo
  if [ "$ACCESS" = https ]; then
    local suffix=""; [ "$HTTPS_PORT_V" = 443 ] || suffix=":${HTTPS_PORT_V}"
    echo "Open WebUI : https://<你的域名>${suffix}   (第一个注册的账号是管理员;域名要解析到这台服务器)"
  else
    echo "Open WebUI : http://127.0.0.1:${WEBUI_PORT_V}   (第一个注册的账号是管理员)"
  fi
  echo "Codex API  : http://127.0.0.1:${API_PORT_V}/v1   (密钥见 .env 的 CODEX_API_KEY,只在本机可访问)"
  echo "数据库     : $(db_label)"
}

cmd_status() {
  load_ports
  echo "数据库: $(db_label)"
  echo "访问  : $(access_label)"
  dc ps
  echo "--- Codex 登录 ---"
  dc exec -T codex-api codex login status 2>&1 || true
  echo "--- 服务 ---"
  dc exec -T codex-api node -e "fetch('http://127.0.0.1:8000/health').then(r=>r.text()).then(console.log)" 2>&1 || true
}

# 换了证书文件后运行:检查新证书,并让正在运行的代理重新加载(不中断连接)
cmd_cert() {
  [ "$ACCESS" = https ] || die "没有启用 HTTPS(.env 里没有 HTTPS=true)"
  check_cert
  if dc ps --status running --services 2>/dev/null | grep -qx proxy; then
    dc exec -T proxy nginx -t
    dc exec -T proxy nginx -s reload
    echo "代理已重新加载,新证书生效。"
  else
    echo "代理没有在运行;./ops.sh up 时会使用这份证书。"
  fi
}

cmd_psql() {
  [ "$DB_MODE" = bundled ] || die "当前用的是外部数据库,请直接用 psql 连接 .env 里的 DATABASE_URL"
  dc exec postgres psql -U openwebui -d openwebui "$@"
}

cmd_init() {
  if [ -f .env ]; then echo ".env 已存在,没有改动。"; else init_env; fi
  echo "编辑 .env 后运行  ./ops.sh up"
}

case "${1:-}" in
  init) cmd_init ;;
  up) cmd_up ;;
  status) setup_stack; cmd_status ;;
  logs) shift; setup_stack; dc logs -f --tail 100 "$@" ;;
  login) setup_stack; cmd_login ;;
  cert) setup_stack; load_ports; cmd_cert ;;
  psql) shift; setup_stack; cmd_psql "$@" ;;
  compose) shift; setup_stack; dc "$@" ;;
  down) setup_stack; dc down ;;
  *) sed -n '2,7p' "$0"; exit 1 ;;
esac
