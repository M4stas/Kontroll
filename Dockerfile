# syntax=docker/dockerfile:1
FROM python:3.12-slim-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends \
    libasound2 libatk1.0-0 libatk-bridge2.0-0 libcairo2 libcups2 libdbus-glib-1-2 \
    libdrm2 libgbm1 libgtk-3-0 libnss3 libpango-1.0-0 libx11-xcb1 libxcomposite1 \
    libxdamage1 libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6 fonts-liberation \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY pyproject.toml ./
RUN --mount=type=cache,target=/root/.cache/pip python - <<'PY'
import subprocess
import sys
import tomllib

with open("pyproject.toml", "rb") as project_file:
    dependencies = tomllib.load(project_file)["project"]["dependencies"]
subprocess.run([sys.executable, "-m", "pip", "install", *dependencies], check=True)
subprocess.run([sys.executable, "-m", "camoufox", "fetch", "official/stable/152.0.4-beta.31"], check=True)
PY
COPY --from=captcha_solver type.onnx grid.onnx grid.meta.json captcha.sqlite LICENSE /opt/captcha-solver/
COPY vendor/captcha-solver/SHA256SUMS vendor/captcha-solver/LICENSE.sha256 /opt/captcha-solver/
RUN cd /opt/captcha-solver && sha256sum -c SHA256SUMS && sha256sum -c LICENSE.sha256
ENV CAPTCHA_SOLVER_DIR=/opt/captcha-solver
COPY src ./src
RUN python -m pip install --no-cache-dir --no-deps .

ENTRYPOINT ["python", "-m", "auto24_service.scrape_once"]
