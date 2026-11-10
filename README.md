# Open WebUI + Codex(Postgres 版)部署说明

把 Codex CLI 转成 OpenAI 兼容 API,前端用 Open WebUI。两件事由 `.env` 里的变量决定:

- **数据库**:自动启动一个内置 Postgres,或连外部 Postgres。
- **访问方式**:HTTPS 直接用 80/443 和你买的证书,或不用 HTTPS(默认只监听本机 3000)。

```
浏览器 ──443──> nginx(你的证书)──> Open WebUI ──> codex-api(转成 `codex exec`)──> OpenAI
                                        │
                                        └──> Postgres(用户、聊天、设置):内置容器 或 外部实例
```

## 目录里有什么

| 文件 | 作用 |
|---|---|
| `compose.yaml` | 核心服务:Open WebUI 和 codex-api(镜像按摘要固定、资源限制、只读根文件系统等) |
| `compose.db.yaml` | 内置 Postgres。只有 `.env` 里 `DATABASE_URL` 为空时才加载 |
| `compose.tls.yaml` + `nginx/default.conf` | HTTPS 代理(nginx,80 跳转、443 用你的证书)。只有 `HTTPS=true` 时才加载 |
| `compose.plain.yaml` | 不用 HTTPS 时,把 Open WebUI 直接发布到 `WEBUI_PORT` |
| `ops.sh` | 运维入口:`init` `up` `status` `logs` `login` `cert` `psql` `compose` `down`。**请用它启动,不要直接 `docker compose up`**,它负责按 `.env` 选好叠加哪些文件 |
| `.env.example` | 配置模板;`.env` 在首次 `./ops.sh up` 时自动生成 |
| `certs/` | 放 HTTPS 证书,见 `certs/README.md` |
| `codex-api/Dockerfile` `codex-api/server.mjs` | Codex 转 API 的服务(无第三方依赖) |
| `postgres/init.sql` | 在外部 Postgres 里建库建账号的 SQL。**只有连外部库才需要** |

## 一、部署

要求:Linux 服务器,Docker + Docker Compose v2,`openssl`,能访问 Docker 镜像仓库、apt 和 npm 源(构建 codex-api 时用)、HuggingFace(Open WebUI 第一次启动会下载嵌入模型)。

### 最简(内置库 + 本机 3000,用来先跑通)

```bash
chmod +x ops.sh
./ops.sh up        # 生成 .env 随机密钥 → 构建 → 启动 → 等服务都健康 → 引导 Codex 登录
```

### 生产(HTTPS 用 80/443 + 你买的证书)

```bash
chmod +x ops.sh
# 1. 域名解析到这台服务器,防火墙放行 80 和 443(80 只用来跳转到 443)
# 2. 证书放进 certs/:fullchain.pem(服务器证书+中间证书链)和 privkey.pem(私钥),整理方法见 certs/README.md
# 3. 生成 .env(随机密钥,不启动),然后编辑它:加上 HTTPS=true;连外部库就再填 DATABASE_URL
./ops.sh init
# 4. 启动
./ops.sh up
```

首次耗时几分钟(拉镜像、装 Codex、下载嵌入模型)。之后:

1. 浏览器打开 `https://你的域名`(最简方式是 `http://127.0.0.1:3000`),**第一个注册的账号是管理员**。
2. Codex 登录:`./ops.sh up` 末尾会引导,也可以随时 `./ops.sh login`。在浏览器打开它显示的链接,输入验证码,用公司 Team 账号登录,验证码 15 分钟内有效。
3. 回到 Open WebUI 选模型,开始对话。

## 二、访问方式:HTTPS 或直连

| | HTTPS(生产) | 直连(默认) |
|---|---|---|
| `.env` | `HTTPS=true` | 不写或 `HTTPS=false` |
| 对外端口 | **80**(跳转)和 **443** | `WEBUI_PORT`,默认 `127.0.0.1:3000` |
| 证书 | 用 `certs/` 里你买的证书 | 无 |
| 代理 | 自带 nginx | 你自己的反向代理(可选) |

HTTPS 模式下 Open WebUI 不再单独占宿主机端口,3000 不会被占用。

### HTTPS 细节

- **证书文件名固定**:`certs/fullchain.pem` 和 `certs/privkey.pem`。买来的 `.crt` + `ca-bundle` + `.key` 怎么拼、`.pfx` 怎么转、私钥带密码怎么去掉,都写在 `certs/README.md`,命令已验证过。
- **启动前自动检查**:文件是否存在、是不是 PEM、私钥是否匹配、是否过期;30 天内到期、缺中间证书链会警告。不通过就在启动前直接说明原因,而不是等 nginx 起不来。
- **续期**:覆盖证书文件,运行 `./ops.sh cert`:先检查,再让 nginx 重新加载,不中断连接。
- **端口**:`.env` 可改 `HTTP_PORT`(默认 80)、`HTTPS_PORT`(默认 443)、`PUBLIC_BIND`(默认 `0.0.0.0`)。改了 `HTTPS_PORT` 后,80 端口的自动跳转仍指向 443,要直接访问 `https://域名:端口`。
- **80/443 已被占用**(服务器上已有 nginx 等):改上面的端口,或者不用 `HTTPS=true`,让你已有的反向代理转发到 `127.0.0.1:3000`。自己转发时必须支持 WebSocket、关闭响应缓冲、调大读超时(Codex 一次回复可能要几分钟),可以照 `nginx/default.conf` 里 `location /` 那段写。
- **只启用 TLS 1.2 / 1.3**;上传大小上限 100MB(`nginx/default.conf` 里 `client_max_body_size`)。
- **HSTS** 默认没开(开了以后证书一出问题用户就无法点"继续访问")。要开就取消 `nginx/default.conf` 里那行注释。
- **只想用 80 端口、明文 HTTP**:`.env` 设 `WEBUI_BIND=0.0.0.0`、`WEBUI_PORT=80`。不推荐,密码和聊天内容会明文传输。

## 三、数据库:二选一

| | 内置 Postgres(默认) | 外部 Postgres |
|---|---|---|
| `.env` | `DATABASE_URL` 留空,填 `POSTGRES_PASSWORD` | 填 `DATABASE_URL`,不再需要 `POSTGRES_PASSWORD` |
| `./ops.sh up` | 自动再启动一个 postgres 容器 | 不启动 postgres 容器 |
| 建库建账号 | 自动(第一次启动时) | 你先执行一次 `postgres/init.sql` |
| 建表 | Open WebUI 第一次启动时自己建、升级时自己迁移 | 同左 |

`ops.sh` 每次启动都会打印当前用的是哪一种(`数据库: 内置 Postgres` 或 `数据库: 外部 Postgres(主机:端口)`),不会打印账号密码。

### 内置 Postgres(自动启动)

不需要做任何数据库操作。第一次启动时一切自动完成:

| 内容 | 值 |
|---|---|
| 数据库、账号 | 都叫 `openwebui`,由 postgres 镜像按 `compose.db.yaml` 里的 `POSTGRES_DB` / `POSTGRES_USER` 建好 |
| 密码 | `.env` 里的 `POSTGRES_PASSWORD`(`ops.sh up` 随机生成) |
| 存放位置 | Docker 卷 `openwebui-codex_pgdata` |
| 网络 | 不发布端口,只有 compose 内部的 Open WebUI 能连 |

进数据库:`./ops.sh psql`

### 外部 Postgres

1. 用管理员账号执行 `postgres/init.sql`(它只建库 `openwebui` 和账号 `openwebui`,不建表;密码从命令行传,文件里有完整说明):

   ```bash
   psql -h <主机> -U <管理员> -d postgres -v ON_ERROR_STOP=1 \
        -v owui_password='强密码' -f postgres/init.sql
   ```

2. 在 `.env` 里填:

   ```
   DATABASE_URL=postgresql://openwebui:<URL编码后的密码>@<主机>:5432/openwebui?sslmode=require
   ```

   密码里的特殊字符要 URL 编码(`@` 写成 `%40`,`$` 写成 `%24`)。不需要 TLS 就去掉 `?sslmode=require`。私有 CA 签发的证书需要把 CA 文件挂进容器,这里没有预置。
3. `./ops.sh up`。启动失败时,先确认 Docker 主机能连上这个地址和端口,再 `./ops.sh logs openwebui`。

### 切换

- 内置 → 外部:`.env` 填上 `DATABASE_URL`,再 `./ops.sh up`。旧的 postgres 容器会被移除,卷 `pgdata` 保留。
- 外部 → 内置:清空 `DATABASE_URL`,再 `./ops.sh up`。
- **切换不会迁移数据**:新库是空的,用户和聊天记录要用 `pg_dump` / `pg_restore` 自己迁。

## 四、配置

### `.env`

| 变量 | 默认 | 说明 |
|---|---|---|
| `WEBUI_SECRET_KEY` | 随机 | Open WebUI 会话签名密钥,换了所有人要重新登录 |
| `CODEX_API_KEY` | 随机 | Open WebUI 访问 codex-api 的密钥,也是直接调 API 的 Bearer |
| `DATABASE_URL` | 空 | 空 = 自动启动内置 Postgres;有值 = 连这个外部库 |
| `POSTGRES_PASSWORD` | 随机 | 仅内置库需要;只用字母数字(会被拼进连接地址) |
| `HTTPS` | `false` | `true` = nginx 监听 80/443,用 `certs/` 里的证书 |
| `HTTP_PORT` / `HTTPS_PORT` / `PUBLIC_BIND` | `80` / `443` / `0.0.0.0` | 仅 `HTTPS=true` 时用 |
| `CERT_DIR` | `./certs` | 证书目录,可指向别处 |
| `WEBUI_BIND` / `WEBUI_PORT` | `127.0.0.1` / `3000` | 仅不用 HTTPS 时用:Open WebUI 的直连监听 |
| `API_BIND` / `API_PORT` | `127.0.0.1` / `8100` | codex-api 监听,只在本机可访问。不需要从宿主机直接调就在 compose 里删掉这个端口映射 |
| `CODEX_SANDBOX` | `read-only` | **不要改成 `danger-full-access`**:容器里有登录令牌 |
| `CODEX_MODELS` | 空 | 额外模型名。模型表默认自动来自 Codex,通常不用填 |
| `SESSION_TTL_DAYS` | `30` | 会话记录和聊天工作目录的保留天数,超期自动清理 |
| `MAX_CONCURRENCY` | `4` | 同时跑的 `codex` 进程数,超出排队(排队超过 5 分钟返回 429) |
| `WEBUI_NAME` | `Codex Web` | 页面标题 |

### `compose.yaml` 里写死的 Open WebUI 设置

| 设置 | 值 | 原因 |
|---|---|---|
| `ENABLE_SIGNUP` | `false` | 关闭自助注册(第一个管理员不受影响) |
| `DEFAULT_USER_ROLE` | `pending` | 新用户先待审批,管理员批准后才能用 |
| `ENABLE_FORWARD_USER_INFO_HEADERS` | `true` | 把用户、会话 ID 传给 codex-api,用来分用户、分会话 |
| 标签、追问、自动补全、搜索词、检索词生成 | `false` | 每个后台任务都会起一次 `codex exec`,耗额度也占并发;只保留标题生成 |

**注意:这些设置是 Open WebUI 的持久化配置——环境变量只在第一次启动时写入数据库,之后以管理员面板(Admin Panel → Settings)里的值为准。** 部署后再改 compose 里的这些值不会生效,要在后台改。

### 账号体系(LDAP)

这里没有预置 LDAP。在 Open WebUI 管理员面板(Admin Panel → Settings → General)里配置。LDAP 用户第一次登录时按 `DEFAULT_USER_ROLE` 建账号,所以默认是待审批,要让他们直接可用,把默认角色改成 `user`。

### 数据放在哪

默认全放在 Docker 命名卷里,位置由 Docker 的数据目录决定(Linux 上一般是 `/var/lib/docker/volumes/`):

| 卷 | 内容 | 丢了会怎样 |
|---|---|---|
| `openwebui-codex_pgdata`(仅内置库) | 用户、聊天记录、各项设置 | **最重要**,丢了全部重来 |
| `openwebui-codex_owui-data` | 上传文件、向量库,以及首次启动下载的嵌入模型 | 上传文件丢失,嵌入模型会重新下载 |
| `openwebui-codex_codex-home` | Codex 登录令牌(敏感) | 重新 `./ops.sh login` 即可 |
| `openwebui-codex_codex-workspace` | 各用户、各会话的工作目录 | 无所谓,超过 `SESSION_TTL_DAYS` 也会自动清理 |

要放到指定磁盘,两种做法:

- **改整个 Docker 的数据目录(最省事)**:`/etc/docker/daemon.json` 写 `{"data-root": "/data/docker"}` 后重启 Docker。要在第一次 `./ops.sh up` 之前改,已有的卷不会自动跟过去。
- **只把这几份数据放到指定目录**:把 `compose.yaml` 里三处卷挂载换成目录,并删掉文件末尾整个顶层 `volumes:` 块;用内置库时 `compose.db.yaml` 同样处理 `pgdata`:

  ```yaml
  # compose.yaml
  - /data/openwebui-codex/codex-home:/home/node/.codex
  - /data/openwebui-codex/codex-workspace:/workspace
  - /data/openwebui-codex/owui-data:/app/backend/data
  # compose.db.yaml
  - /data/openwebui-codex/pgdata:/var/lib/postgresql/data
  ```

  启动前建目录;`codex-api` 以 `node`(uid 1000)运行且去掉了所有权限,所以这两个目录要预先给它:

  ```bash
  mkdir -p /data/openwebui-codex/{pgdata,codex-home,codex-workspace,owui-data}
  chown 1000:1000 /data/openwebui-codex/{codex-home,codex-workspace}
  chmod 700 /data/openwebui-codex/codex-home      # 里面有登录令牌
  ```

  这种写法只验证过 `docker compose config` 能通过,没有真正启动过,第一次用请先确认服务都健康。

## 五、Codex 登录(公司 Team 账号)

- `./ops.sh login` 用设备码登录。页面提示没有启用设备码登录时,需要先在 ChatGPT 的安全设置里开启;**Team 工作区可能要管理员开启,这一点没有在 Team 账号上验证过。**
- 登录令牌保存在卷 `openwebui-codex_codex-home`(敏感),重启不丢。登录失效(改密码、被撤销)时,聊天里会直接提示"登录已失效",重新 `./ops.sh login` 即可。
- 所有用户共用这一个账号的额度。Open WebUI 里选模型 **Codex quota** 发任意消息,可以看当前额度。

## 六、日常运维

```bash
./ops.sh init                # 只生成 .env(随机密钥),不启动
./ops.sh status              # 数据库和访问模式 + 容器状态 + Codex 登录状态 + 服务健康
./ops.sh logs                # 全部日志;或 ./ops.sh logs codex-api|openwebui|postgres|proxy
./ops.sh up                  # 改了配置后重新应用(幂等)
./ops.sh cert                # 换了证书文件后:检查并让 nginx 重新加载
./ops.sh psql                # 进内置库的 psql(外部库请直接用你自己的 psql)
./ops.sh compose <参数>       # 需要 docker compose 原生命令时用它,例如 ./ops.sh compose ps
./ops.sh down                # 停止,数据都在
```

- **数据都在 Docker 卷里**(见上文)。`docker compose down -v` 会把它们全部删掉,不要用。
- 日志按 10MB × 5 个文件自动轮转;codex-api 每个请求一行 JSON(用户、会话、模型、耗时、token)。
- **停止是优雅的**:codex-api 会等进行中的请求跑完(最多 2 分钟)再退出。
- **升级**:镜像按摘要固定,Codex 固定为 0.167.0。聊天桥依赖 Codex 的事件格式和会话记录格式,升级 Codex 前先在测试环境验证。Open WebUI 升级后数据库会被自动迁移,不能再退回旧版本。

## 七、已知限制

- 容器里 Codex 的沙箱跑不起来(没有命名空间权限),所以只能聊天和搜索,不能让它在服务器上执行命令。这是有意保持的只读,不要为了让它执行命令去放开。
- 没有按用户限额,所有人共用一个账号的额度。
- 备份没有包含在这个方案里。
- **HTTPS 代理(nginx 容器)没有在真实环境里启动过**:nginx 配置语法、compose 各种组合、证书检查逻辑都验证过,但容器本身没跑过。第一次部署后,请确认 `./ops.sh status` 里 `proxy` 是 healthy,并用浏览器实际打开 `https://你的域名`、发一条消息(流式输出和 WebSocket 都要正常)。
