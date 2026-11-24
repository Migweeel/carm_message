FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    MODEL_DIR=/data

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential gosu \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .
COPY test_main.py .
COPY data/ ./data/
COPY docker-entrypoint.sh /usr/local/bin/recommender-entrypoint
RUN python -m unittest -v
RUN useradd --create-home --uid 10001 recommender \
    && mkdir -p /data \
    && chmod +x /usr/local/bin/recommender-entrypoint \
    && chown -R recommender:recommender /app /data

EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/recommender-entrypoint"]
