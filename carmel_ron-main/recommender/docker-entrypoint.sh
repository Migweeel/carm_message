#!/bin/sh
set -eu

mkdir -p "$MODEL_DIR"
chown -R recommender:recommender "$MODEL_DIR"
exec gosu recommender uvicorn main:app --host 0.0.0.0 --port 8000
