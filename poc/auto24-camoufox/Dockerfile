FROM python:3.12-slim-bookworm

RUN pip install --no-cache-dir camoufox beautifulsoup4 \
    && python -m playwright install-deps firefox \
    && python -m camoufox fetch

WORKDIR /app
COPY scrape.py /app/scrape.py
ENTRYPOINT ["python", "/app/scrape.py"]
