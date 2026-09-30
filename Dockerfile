FROM python:3.13-alpine
WORKDIR /app
COPY sync/app.py /app/app.py
COPY LICENSE THIRD_PARTY_NOTICES.md /app/
ENV DATA_DIR=/data \
    PORT=8788 \
    PYTHONUNBUFFERED=1
VOLUME ["/data"]
EXPOSE 8788
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8788/health', timeout=2).read()" || exit 1
CMD ["python", "/app/app.py"]

