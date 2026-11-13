# Backup runner for the nightly CronJob: pg_dump/pg_restore + AWS CLI + gsutil-free S3 upload.
FROM postgres:16-bookworm
RUN apt-get update && apt-get install -y --no-install-recommends awscli gnupg ca-certificates && rm -rf /var/lib/apt/lists/*
COPY scripts/backup.sh scripts/restore.sh /usr/local/bin/
USER postgres
ENTRYPOINT ["/usr/local/bin/backup.sh"]
