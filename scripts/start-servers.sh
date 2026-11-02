#!/bin/bash
# 启动前端依赖的两个服务：MariaDB（MySQL 兼容）+ MinIO
# 凭据与 backend/.env 保持一致：MySQL root/123456@127.0.0.1:3306/test_db，MinIO minioadmin@127.0.0.1:9100

set -u

# --- MariaDB / MySQL ---
if ! mysqladmin ping >/dev/null 2>&1; then
  sudo service mariadb start >/dev/null 2>&1 || sudo mysqld_safe >/dev/null 2>&1 &
  for i in $(seq 1 30); do
    mysqladmin ping >/dev/null 2>&1 && break
    sleep 1
  done
fi
mysqladmin ping && echo "mysql: running" || echo "mysql: FAILED to start"

# 确保 root/123456 可经 TCP 登录、test_db 存在（幂等）
mysql -uroot -p123456 -h127.0.0.1 -P3306 -e "SELECT 1" >/dev/null 2>&1 || {
  # 首次安装：root 走 unix_socket 登录
  sudo mysql -e "
    ALTER USER 'root'@'localhost' IDENTIFIED BY '123456';
    CREATE USER IF NOT EXISTS 'root'@'127.0.0.1' IDENTIFIED BY '123456';
    CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY '123456';
    GRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;
    GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION;
    FLUSH PRIVILEGES;" >/dev/null 2>&1
}
mysql -uroot -p123456 -h127.0.0.1 -P3306 -e "CREATE DATABASE IF NOT EXISTS test_db" 2>/dev/null \
  && echo "mysql: root/123456 ok, test_db ready" \
  || echo "mysql: user check failed"

# --- MinIO ---
if ! curl -sf -m 2 http://127.0.0.1:9100/minio/health/live >/dev/null 2>&1; then
  mkdir -p "$PWD/storage/minio-data"
  MINIO_ROOT_USER=minioadmin MINIO_ROOT_PASSWORD=minioadmin \
    nohup minio server "$PWD/storage/minio-data" \
      --address 127.0.0.1:9100 --console-address 127.0.0.1:9101 \
      > /tmp/minio.log 2>&1 &
  for i in $(seq 1 30); do
    curl -sf -m 2 http://127.0.0.1:9100/minio/health/live >/dev/null 2>&1 && break
    sleep 1
  done
fi
curl -sf -m 2 http://127.0.0.1:9100/minio/health/live >/dev/null 2>&1 \
  && echo "minio: running at 127.0.0.1:9100 (console 9101)" \
  || echo "minio: FAILED to start (see /tmp/minio.log)"
