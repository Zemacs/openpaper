#!/bin/bash
set -e

# Setup dependencies in a virtual environment.
uv sync
source .venv/bin/activate

# Start RabbitMQ and Redis services using Docker. Start existing containers or create new ones.
docker start op-rabbitmq 2>/dev/null || docker run -d --name op-rabbitmq -p 5672:5672 rabbitmq
docker start op-redis 2>/dev/null || docker run -d --name op-redis -p 6379:6379 redis

worker_pid=""
api_pid=""

cleanup() {
    exit_code=$?
    trap - INT TERM EXIT

    if [ -n "$api_pid" ] && kill -0 "$api_pid" 2>/dev/null; then
        kill -TERM "$api_pid" 2>/dev/null || true
    fi

    if [ -n "$worker_pid" ] && kill -0 "$worker_pid" 2>/dev/null; then
        kill -TERM "$worker_pid" 2>/dev/null || true
    fi

    [ -n "$api_pid" ] && wait "$api_pid" 2>/dev/null || true
    [ -n "$worker_pid" ] && wait "$worker_pid" 2>/dev/null || true

    exit "$exit_code"
}

trap cleanup INT TERM EXIT

# Start Celery worker and API as child processes managed by this script.
./scripts/start_worker.sh &
worker_pid=$!

./scripts/start_api.sh &
api_pid=$!

# Keep script attached to API lifecycle; cleanup trap will stop both processes.
wait "$api_pid"
