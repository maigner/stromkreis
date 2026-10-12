# Pipeline-Worker fuer das Testdeployment (deploy/docker-compose.yml, Dienst "worker").
# Basis-Image und Abhaengigkeiten sind gepinnt (requirements.lock), damit ein
# Rebuild reproduzierbar bleibt; das Paket selbst kommt ohne Aufloesung dazu.
FROM python:3.12.15-slim
WORKDIR /app
COPY pyproject.toml README.md requirements.lock ./
COPY stromkreis_pipeline ./stromkreis_pipeline
RUN pip install --no-cache-dir -r requirements.lock \
    && pip install --no-cache-dir --no-deps . \
    && useradd -r -u 1000 worker
USER worker
ENV TZ=Europe/Vienna PYTHONUNBUFFERED=1
CMD ["python", "-m", "stromkreis_pipeline", "worker"]
