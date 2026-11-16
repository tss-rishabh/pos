FROM python:3.12.15-slim@sha256:a0f57064cbdcd6285fa45f51237ab0b35ea8ebaed06a1f5973e89e19dfb86704
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_DISABLE_PIP_VERSION_CHECK=1
WORKDIR /app
COPY requirements.txt /tmp/contact-requirements.txt
RUN pip install --no-cache-dir --require-hashes -r /tmp/contact-requirements.txt
COPY --chown=10001:10001 contract.py codec.py models.py service.py app.py adapters.py runtime.py privacy-candidate-manifest.json /app/
USER 10001:10001
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/healthz', timeout=3).close()"
CMD ["gunicorn","--bind","0.0.0.0:8080","--workers","2","--threads","2","--timeout","20","--graceful-timeout","10","--access-logfile","/dev/null","--error-logfile","/dev/null","runtime:create_application()"]
