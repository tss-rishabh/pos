#!/bin/sh
# Sourced by bounded workflow runners. The caller installs its cleanup trap first.
workflow_mysql_container=''
workflow_mysql_nonce=''

workflow_mysql_start() {
  case "$1" in
    pos_rewrite_archival_workflow|pos_rewrite_global_reminders) ;;
    *) echo 'Unsupported native workflow schema.' >&2; return 1 ;;
  esac
  workflow_mysql_nonce=$(basename -- "$task_temporary")
  workflow_mysql_container=$(docker create --pull=never \
    --label "pos-rewrite.workflow-fixture=$workflow_mysql_nonce" \
    -p 127.0.0.1::3306 -e MYSQL_ALLOW_EMPTY_PASSWORD=yes -e "MYSQL_DATABASE=$1" \
    mysql@sha256:ccb8f749bb5e59f9f8f03bf7282c7ef27a93a1814a24f0a8a926fb4e19b7fb97)
  docker start "$workflow_mysql_container" >/dev/null
  workflow_mysql_attempt=0
  until docker exec "$workflow_mysql_container" mysql --protocol=TCP \
    -h 127.0.0.1 -uroot -D "$1" -e 'SELECT 1' >/dev/null 2>&1; do
    workflow_mysql_attempt=$((workflow_mysql_attempt + 1))
    if [ "$workflow_mysql_attempt" -ge 60 ]; then
      echo 'The owned native workflow database did not become ready.' >&2
      return 1
    fi
    sleep 1
  done
  workflow_mysql_port=$(docker port "$workflow_mysql_container" 3306/tcp | cut -d: -f2)
  case "$workflow_mysql_port" in
    ''|*[!0-9]*) echo 'Invalid native workflow loopback port.' >&2; return 1 ;;
  esac
  workflow_mysql_url="mysql://root@127.0.0.1:$workflow_mysql_port/$1"
}

workflow_mysql_cleanup() {
  if [ -n "$workflow_mysql_container" ] && \
    [ "$(docker inspect --format '{{index .Config.Labels "pos-rewrite.workflow-fixture"}}' \
      "$workflow_mysql_container" 2>/dev/null)" = "$workflow_mysql_nonce" ]; then
    docker rm -fv "$workflow_mysql_container" >/dev/null 2>&1 || true
  fi
}
