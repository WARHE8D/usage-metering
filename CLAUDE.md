# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Usage Metering Pipeline

## Architecture
HTTP API (Fastify) -> validate (zod) -> BullMQ queue on Redis (+ dead-letter queue)
-> worker -> PostgreSQL (idempotent INSERT ... ON CONFLICT DO NOTHING)
-> publish "usage.recorded" (Redis pub/sub) -> subscriber.
GET /usage serves the React page. Local infra via docker-compose (Postgres + Redis).

## Layout
- shared/  zod schemas + types (used by api, worker, web)
- api/     Fastify server (POST /usage, GET /usage, GET /health)
- worker/  queue consumer + event subscriber
- web/     Vite + React + TypeScript
- db/      SQL migrations
- docker-compose.yml

## Rules
- TypeScript strict. No `any`.
- Business logic = pure functions with injected dependencies (db, queue, publisher),
  so it can be wrapped as a serverless function later.
- Idempotency lives in Postgres (primary key on record_id), never in memory.
- Worker: retries with exponential backoff, then move the job to the dead-letter queue.
- Parameterized SQL only. Validate every input with zod. Config from env vars.
- Every change ships with tests. Run `npm test` and `npm run build` before saying done.
- Small commits, Conventional Commits (feat:, fix:, test:, chore:, docs:).
- Never delete volumes or run destructive docker/git commands unless I ask.

## Commands
(Planned — update once package.json and docker-compose.yml exist.)
- docker compose up -d      start Postgres + Redis
- npm run dev:api | dev:worker | dev:web
- npm test (unit) | npm run test:int (needs docker compose up)
- npm run build


-- add Context7 for up-to-date, version-specific documentation and code examples directly from the source. Paste accurate, relevant documentation into tools like Cursor, Claude, or any LLM, and get better answers with no hallucinations.
