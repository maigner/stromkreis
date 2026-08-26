# Pipeline-Worker fuer das Testdeployment (deploy/docker-compose.yml, Dienst "worker").
FROM python:3.12-slim
WORKDIR /app
COPY pyproject.toml README.md ./
COPY stromkreis_pipeline ./stromkreis_pipeline
RUN pip install --no-cache-dir . && useradd -r -u 1000 worker
USER worker
ENV TZ=Europe/Vienna PYTHONUNBUFFERED=1
CMD ["python", "-m", "stromkreis_pipeline", "worker"]
