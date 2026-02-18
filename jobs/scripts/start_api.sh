#!/bin/bash

# Start FastAPI application
echo "Starting FastAPI application..."
source .venv/bin/activate
exec python -m uvicorn src.app:app --host 0.0.0.0 --port 8001 --log-level info
