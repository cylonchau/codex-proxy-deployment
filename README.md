# Open WebUI + Codex(Postgres 版)

把 Codex CLI 转成 OpenAI 兼容 API,前端用 Open WebUI,数据库是 Postgres。

## 一键启动

```bash
./ops.sh up
```

会自动:生成 `.env`(随机密钥)→ 构建并启动 → 等全部服务健康 → 引导 Codex 登录。
需要 Docker 和 Docker Compose v2、openssl。

- Open WebUI:http://127.0.0.1:3000(第一个注册的账号是管理员,之后关闭自助注册,新用户默认待审批)
- Codex API:http://127.0.0.1:8100/v1(Bearer 密钥是 `.env` 里的 `CODEX_API_KEY`)

其他命令:`./ops.sh status` · `./ops.sh logs [postgres|codex-api|openwebui]` · `./ops.sh login` · `./ops.sh down`

## 部署到新环境

只需要拷这些配置文件,不需要任何数据,也不要拷 `.env`(新环境会生成自己的密钥):

```
compose.yaml  ops.sh  .env.example  .gitignore  codex-api/Dockerfile  codex-api/server.mjs
```

## 登录 Codex

`./ops.sh up` 末尾会引导;也可以随时 `./ops.sh login`:在浏览器打开显示的链接,输入验证码,15 分钟内有效。
页面提示未启用设备码登录时,需要在 ChatGPT 设置里开启(Team 工作区可能要管理员开启)。登录令牌保存在 `codex-home` 卷里,重启不丢。

## 可选配置

见 `.env.example`:端口、监听地址、并发数、会话保留天数等。

## 版本固定

镜像按摘要固定,Codex 固定为 0.167.0(`compose.yaml` 与 `codex-api/Dockerfile`)。聊天桥依赖 Codex 的事件格式和会话记录格式,**升级 Codex 前先在测试环境验证**。

## 要知道的

- 只监听 127.0.0.1。要让别人访问,放到带 HTTPS 的反向代理后面(Open WebUI 需要 WebSocket)。
- 所有用户共用同一个 Codex 账号的额度,没有按用户限额。Open WebUI 里选 "Codex quota" 可以看当前额度。
- Codex 沙箱是只读,而且容器里跑不了命令,只能聊天和搜索。不要改成 `danger-full-access`:容器里有登录令牌。
- 首次启动 Open WebUI 会从 HuggingFace 下载嵌入模型,服务器需要能访问它。
- 每个用户、每个会话在 `/workspace/users/<用户>/chats/<会话>` 有独立目录;超过 `SESSION_TTL_DAYS` 没动的会话记录和目录会被自动清理。
- LDAP 在 Open WebUI 管理后台里配置,这里没有预置。
- `docker compose down -v` 会删除数据库、登录和所有数据,谨慎使用;`./ops.sh down` 不会。
