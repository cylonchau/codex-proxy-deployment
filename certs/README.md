# HTTPS 证书放这里

`.env` 里设 `HTTPS=true` 后,nginx 读取这个目录里的两个文件,**文件名固定**:

| 文件 | 内容 |
|---|---|
| `fullchain.pem` | 服务器证书,**后面接中间证书链**(服务器证书必须排第一张) |
| `privkey.pem` | 私钥,不能有密码保护 |

两个文件都是 PEM 文本格式(以 `-----BEGIN` 开头)。**私钥不要进 git、不要发给别人**——这个目录里除本说明外的文件已被 `.gitignore` 忽略。

## 买来的证书怎么整理

证书商通常给你三样:服务器证书(`xxx.crt`)、中间证书(`ca-bundle.crt` 之类)、私钥(`xxx.key`,生成 CSR 时留下的)。

```bash
cat xxx.crt ca-bundle.crt > fullchain.pem     # 服务器证书在前,中间证书在后
cp xxx.key privkey.pem
chmod 600 privkey.pem
```

只有 `.pfx` / `.p12` 的话:

```bash
openssl pkcs12 -in xxx.pfx -nokeys -out fullchain.pem        # 证书和链
openssl pkcs12 -in xxx.pfx -nocerts -nodes -out privkey.pem  # 私钥(-nodes 表示不加密)
chmod 600 privkey.pem
```

旧版本生成的 `.pfx` 在 OpenSSL 3 上读取报错(unsupported)时,两条 `pkcs12` 命令都加上 `-legacy`。

私钥有密码保护时(开头是 `-----BEGIN ENCRYPTED PRIVATE KEY-----`),去掉密码:

```bash
openssl pkey -in 带密码的.key -out privkey.pem
```

## 检查和更换

- `./ops.sh up` 启动前会检查:文件是否存在、是否 PEM、私钥是否匹配、是否过期(30 天内到期会警告)、有没有中间证书链。
- 续期换新证书:覆盖这两个文件,运行 `./ops.sh cert`。它会先检查,再让 nginx 重新加载,不中断连接。
- 证书目录想放别处(比如 `/etc/ssl/openwebui`):`.env` 里设 `CERT_DIR=/etc/ssl/openwebui`。
