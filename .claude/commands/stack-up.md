---
description: Start local infra and smoke-test the pipeline
---
Run `docker compose up -d`, wait until Postgres and Redis are healthy, apply
migrations, start api and worker, POST a sample record and confirm one row in
Postgres and one event received. Report results. Do not delete volumes.