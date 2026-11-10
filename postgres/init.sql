-- Open WebUI 用的数据库和账号。
--
-- 只在「使用自己已有的 Postgres」时才需要执行这个文件。
-- 自带的 compose 方案不需要:postgres 容器第一次启动时,会按 .env 的 POSTGRES_PASSWORD
-- 自动创建同名的库和账号(openwebui / openwebui)。
--
-- 用 Postgres 管理员账号执行(密码从命令行传入,不要写进文件):
--   psql -h <主机> -U <管理员> -d postgres -v ON_ERROR_STOP=1 \
--        -v owui_password='换成一个强密码' -f postgres/init.sql
--
-- 托管数据库(RDS 等)如果 CREATE DATABASE 报 "must be member of role",
-- 先执行:  GRANT openwebui TO <管理员账号>;
--
-- 这里只建库和账号,不建表。表由 Open WebUI 在第一次启动时自己创建并升级
-- (内置迁移,存在 alembic_version 表里)。不要手工建表,也不要导入别的表结构。

CREATE ROLE openwebui LOGIN PASSWORD :'owui_password';

CREATE DATABASE openwebui
    OWNER openwebui
    ENCODING 'UTF8'
    TEMPLATE template0;

-- 库的所有者能在 public 模式里建表(PostgreSQL 15 起其他账号默认不行,所以必须由 openwebui 当所有者)。
-- 收回 PUBLIC 的默认连接权限:只有 openwebui 和管理员能连这个库。
REVOKE ALL ON DATABASE openwebui FROM PUBLIC;

-- 默认的向量库是内置的 Chroma(数据在 owui-data 卷里),不需要任何 Postgres 扩展。
-- 只有把 VECTOR_DB 改成 pgvector 时,才需要在这个库里执行 CREATE EXTENSION vector。
