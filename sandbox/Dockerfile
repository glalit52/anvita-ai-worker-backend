# Image for Anvita code sandboxes: Python 3.12 + Node 22 with common data/report libraries.
# Containers run with no network, a read-only root, dropped capabilities and CPU/memory/pid limits
# (see src/sandbox/docker.ts), so everything code needs must be baked in here.
FROM python:3.12-slim

ARG NODE_MAJOR=22
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl fonts-dejavu-core \
 && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
 && apt-get install -y --no-install-recommends nodejs \
 && apt-get purge -y curl && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
      pandas==2.2.3 numpy==2.1.3 matplotlib==3.9.2 openpyxl==3.1.5 xlsxwriter==3.2.0 \
      fpdf2==2.8.1 python-dateutil==2.9.0.post0 pypdf==5.1.0 tabulate==0.9.0

ENV MPLBACKEND=Agg MPLCONFIGDIR=/tmp HOME=/tmp PYTHONDONTWRITEBYTECODE=1
RUN useradd --uid 10001 --no-create-home --shell /usr/sbin/nologin sandbox
USER 10001
WORKDIR /work
