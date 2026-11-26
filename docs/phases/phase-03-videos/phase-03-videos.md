---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-25T11:23:57-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-25T14:15:09-0300"
  docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md: "2026-11-25T11:23:57-0300"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Deliver the complete video upload and processing pipeline: object storage for videos and thumbnails, a background processing queue with a FFmpeg worker, direct-to-storage upload of files up to 10GB (presigned URLs + multipart), automatic metadata/thumbnail extraction, unique video URLs, and streaming/download via HTTP range requests — establishing the media foundation for all subsequent phases.

---

## Step Implementations

### SI-03.1 — Dependencies, Config Namespaces, and Docker Compose Infrastructure

**Description:** Install all Phase 03 production dependencies, create `storage` and `queue` config namespaces following the `registerAs` pattern, extend the Joi validation schema, and add the MinIO, Redis, and video-worker services to Docker Compose.

**Technical actions:**

- Install production dependencies in nestjs-project: `@nestjs/bullmq@^12.x`, `bullmq@^6.x`, `ioredis@^6.x`, `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`, `fluent-ffmpeg@^2.x` (and dev `@types/fluent-ffmpeg@^2.x`)
- Create `src/config/storage.config.ts` — `registerAs('storage', ...)` reading `S3_ENDPOINT` (string, default `'http://minio:9000'`), `S3_REGION` (string, default `'us-east-1'`), `S3_ACCESS_KEY` (string, required), `S3_SECRET_KEY` (string, required), `S3_VIDEO_BUCKET` (string, default `'videos'`), `S3_THUMBNAIL_BUCKET` (string, default `'thumbnails'`), `S3_FORCE_PATH_STYLE` (string, default `'true'`), `PRESIGNED_URL_EXPIRATION` (number, default `3600`)
- Create `src/config/queue.config.ts` — `registerAs('queue', ...)` reading `REDIS_HOST` (string, default `'redis'`), `REDIS_PORT` (number, default `6379`)
- Update `src/config/env.validation.ts` — add all new environment variables to the Joi schema (`S3_ACCESS_KEY` and `S3_SECRET_KEY` required, others with defaults). Update `.env.example` with all new variables and Docker Compose-compatible defaults
- Add MinIO service to `nestjs-project/compose.yaml` — image `minio/minio`, S3 API on port 9000, console on 9001, `MINIO_ROOT_USER`/`MINIO_ROOT_PASSWORD` env, healthcheck against `/minio/health/live`
- Add Redis service to `nestjs-project/compose.yaml` — image `redis:7-alpine`, port 6379, healthcheck via `redis-cli ping`
- Add `video-worker` service to `nestjs-project/compose.yaml` — build from `worker/Dockerfile.worker` (FFmpeg installed), depends on Redis + MinIO healthy, runs the worker entrypoint
- Create `nestjs-project/worker/Dockerfile.worker` — `node:25.6.0-slim` base with `apt-get install -y ffmpeg`, WORKDIR `/home/node/app`, `USER node`

**Dependencies:** None

**Acceptance criteria:**

- Application starts without errors when all new environment variables are provided — existing E2E test (`GET /` returns 200) still passes
- Starting the application without `S3_ACCESS_KEY` causes a Joi validation error at bootstrap — the app does not start
- `docker compose up -d` brings up MinIO (9000/9001), Redis (6379), and the `video-worker` container alongside the API, all healthy

---

### SI-03.2 — Video Entity and Migration

**Description:** Create the `Video` entity linked to `Channel` (many-to-one), with status lifecycle enum, storage keys, duration, metadata, and unique public identifier. Generate the migration.

**Technical actions:**

- Create `src/videos/entities/video.entity.ts` — `@Entity('videos')` with columns:
  - `id` (uuid PK generated — doubles as the public URL identifier per TD-06)
  - `channel_id` (uuid FK → channels, not null)
  - `title` (varchar, not null)
  - `status` (enum: `'draft'`, `'processing'`, `'ready'`, `'error'`, default `'draft'`) — PostgreSQL enum `videos_status_enum`
  - `storage_key` (varchar, not null — object key in the video bucket, e.g. `videos/{id}/original`)
  - `thumbnail_key` (varchar, nullable — object key in the thumbnail bucket)
  - `duration` (integer, nullable — seconds, filled by the worker)
  - `metadata` (jsonb, nullable — width/height/codec filled by the worker)
  - `error_message` (text, nullable — set on processing failure)
  - `created_at` (CreateDateColumn), `updated_at` (UpdateDateColumn)
  - `@ManyToOne(() => Channel)` with `@JoinColumn({ name: 'channel_id' })`
- Generate migration via `npm run migration:generate -- src/database/migrations/CreateVideos` and review the generated SQL (enum type, FK, index on `channel_id`)
- Create `src/videos/videos.module.ts` — `VideosModule` with `TypeOrmModule.forFeature([Video])` in imports, exporting `TypeOrmModule`

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/entities/video.entity.integration-spec.ts` | Integration | Status enum values, default `draft`, FK to channel, `storage_key` required, nullable `duration`/`metadata`/`thumbnail_key`/`error_message`, timestamps auto-populated |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with TypeOrmModule.forFeature wiring |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `npm run migration:run` creates the `videos` table with the `videos_status_enum` type, FK to `channels`, and index on `channel_id`
- Inserting a video with an invalid status value is rejected by the enum constraint
- A newly created video has `status = 'draft'` by default and a generated uuid `id`

---

### SI-03.3 — Storage Service (S3/MinIO + Presigned URLs)

**Description:** Create a `StorageService` wrapping the S3 client, with typed methods for presigned upload/download URLs, multipart orchestration, object existence, and range-based streaming reads.

**Technical actions:**

- Create `src/videos/storage.service.ts` — `StorageService` injecting `storageConfig`. Construct `S3Client` with `region`, `endpoint`, `credentials`, `forcePathStyle`. Methods:
  - `createPresignedPut(key, contentType): Promise<string>` — `getSignedUrl(client, new PutObjectCommand(...), { expiresIn })`
  - `createMultipartUpload(key, contentType): Promise<string>` — `CreateMultipartUpload` → returns `UploadId`
  - `createPresignedUploadPart(key, uploadId, partNumber): Promise<string>` — `getSignedUrl(UploadPartCommand)`
  - `completeMultipartUpload(key, uploadId, parts: {PartNumber, ETag}[]): Promise<void>` — `CompleteMultipartUpload`
  - `abortMultipartUpload(key, uploadId): Promise<void>` — cleanup on failure
  - `getObject(key, range?: string): Promise<{ body, contentLength, contentType, contentRange }>` — `GetObject` with optional `Range` header for streaming
  - `objectExists(key): Promise<boolean>` — `HeadObject` catch `NotFound`
- Create `src/videos/storage.service.spec.ts` — unit test with a mocked `S3Client` verifying each method invokes the correct command

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/storage.service.spec.ts` | Unit | Each method builds the correct S3 command and passes options (bucket, key, range, expiration) |

**Dependencies:** SI-03.1

**Acceptance criteria:**

- `createPresignedPut` returns a URL that, when `PUT` to directly with the file bytes, stores the object in MinIO without going through the API
- `getObject` with a `Range` header returns the partial body and the correct `contentRange`/`contentLength`

---

### SI-03.4 — Queue Module and Video Processor (Worker)

**Description:** Configure BullMQ (`@nestjs/bullmq`) with Redis, register the `video-processing` queue, and implement a `VideoProcessingProcessor` that consumes jobs, runs FFmpeg/ffprobe, extracts metadata, generates the thumbnail, and updates the video status. The processor runs inside the `video-worker` container.

**Technical actions:**

- Create `src/videos/videos.queue.ts` — queue name constant `VIDEO_PROCESSING_QUEUE = 'video-processing'` and job name constant `VIDEO_PROCESS_JOB = 'process-video'` (`as const`)
- Update `src/videos/videos.module.ts` — add `BullModule.forRootAsync` (inject `queueConfig.KEY`, connection `{ host, port }`) and `BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE })`. Provide `VideoProcessingProcessor`
- Create `src/videos/video-processing.processor.ts` — `@Processor(VIDEO_PROCESSING_QUEUE)` class extending `WorkerHost`. In `process(job: Job<{ videoId: string }>)`:
  1. Load the video by id; if not found, return (job is stale)
  2. Set `status = 'processing'` and save
  3. Download the object from storage to a temp file (via `getObject` stream piped to `fs.createWriteStream` in a temp dir)
  4. Run `ffmpeg.ffprobe(tempPath)` → extract `duration` (seconds) and stream metadata (`width`, `height`, `codec_name`) → persist into `metadata` jsonb
  5. Run `ffmpeg(tempPath).screenshots({ count: 1, folder: tempDir, filename: 'thumbnail.png', size: '640x360' })` → upload the thumbnail via `putObject` to the thumbnail bucket with key `thumbnails/{videoId}/thumbnail.png`
  6. Set `duration`, `metadata`, `thumbnail_key`, `status = 'ready'` and save
  7. On any error, set `status = 'error'`, `error_message`, save, and rethrow so BullMQ records the failed job (with `attempts`/`backoff` configured)
  8. Finally, delete the temp files
- Update `src/videos/videos.module.ts` — inject `StorageService` and `Repository<Video>` into the processor

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/video-processing.processor.spec.ts` | Unit | `process` loads video, sets `processing`, extracts metadata, generates thumbnail, sets `ready`; on ffprobe/ffmpeg failure sets `error` + `error_message` and rethrows |
| `src/videos/videos.module.spec.ts` | Unit | Module compiles with BullMQ forRootAsync + registerQueue + processor wiring |

**Dependencies:** SI-03.2, SI-03.3

**Acceptance criteria:**

- The worker consumes a `process-video` job, extracts duration/resolution via ffprobe, generates a thumbnail, uploads it to the thumbnail bucket, and transitions the video to `ready`
- A job with `attempts: 3` and exponential `backoff` is re-enqueued on failure; after exhausting attempts the video transitions to `error` with `error_message` populated
- The FFmpeg binaries are available in the `video-worker` container (installed in `worker/Dockerfile.worker`)

---

### SI-03.5 — Videos Service (Upload Orchestration and Status Lifecycle)

**Description:** Implement `VideosService` orchestrating the presigned upload flow (initiate → presigned parts → complete) and the status lifecycle, enqueuing the processing job after completion.

**Technical actions:**

- Create `src/videos/videos.service.ts` — `VideosService` injecting `Repository<Video>`, `StorageService`, and `@InjectQueue(VIDEO_PROCESSING_QUEUE)`. Methods:
  - `initiateUpload(channelId, { title, fileName, contentType, fileSize }): Promise<Video>` — creates the video row in `status = 'draft'` with `storage_key = videos/{id}/original`, then calls `storageService.createMultipartUpload(storageKey, contentType)` and stores the uploadId (returned to the client; the uploadId is held in memory/response, not persisted in Phase 03 — the video row is the draft record)
  - `getPresignedUploadParts(videoId, uploadId, partNumbers): Promise<{ partNumber, url }[]>` — generates a presigned `UploadPart` URL per part
  - `completeUpload(videoId, uploadId, parts): Promise<Video>` — calls `storageService.completeMultipartUpload`, then `queue.add(VIDEO_PROCESS_JOB, { videoId })` to enqueue processing; returns the video
  - `findOneById(id): Promise<Video | null>` — public lookup for status polling
  - `findByChannel(channelId): Promise<Video[]>` — list videos for a channel (future phase uses this)
- Implement status transitions: `draft` (initiate) → `processing` (worker) → `ready`/`error` (worker). No direct `ready`/`error` writes from the service — those are owned by the processor (SI-03.4)

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `initiateUpload` creates draft with storage_key, calls CreateMultipartUpload; `completeUpload` completes multipart then enqueues `process-video`; `findOneById` returns the video |
| `src/videos/videos.service.integration-spec.ts` | Integration | `initiateUpload` persists a draft row with correct channel FK and storage_key; `completeUpload` enqueues a job (assert via queue.getJobs) |

**Dependencies:** SI-03.2, SI-03.3, SI-03.4

**Acceptance criteria:**

- `initiateUpload` persists the video as `draft` (pre-registered at upload start) with a unique uuid `id` and `storage_key`
- `completeUpload` finalizes the multipart upload in MinIO and enqueues a `process-video` job — the video remains `draft` until the worker picks it up
- The upload byte stream never passes through the API (only presigned URLs are exchanged)

---

### SI-03.6 — Videos Controller (Initiate/Complete Upload and Status)

**Description:** Expose the upload orchestration and status endpoints, protected by the global JWT guard (videos belong to the authenticated user's channel).

**Technical actions:**

- Create `src/videos/videos.controller.ts` — `VideosController` with route prefix `videos`, injecting `VideosService`. Endpoints:
  - `POST /videos/uploads` (auth) — body `{ title, fileName, contentType, fileSize }` → returns 201 with `{ videoId, uploadId, storageKey }`
  - `POST /videos/uploads/:videoId/parts` (auth) — body `{ uploadId, partNumbers: number[] }` → returns `{ parts: [{ partNumber, url }] }`
  - `POST /videos/uploads/:videoId/complete` (auth) — body `{ uploadId, parts: [{ partNumber, etag }] }` → returns 200 with the video
  - `GET /videos/:id` (public — `@Public()`) — returns the video metadata (id, title, status, duration) for polling/display
- Create DTOs: `initiate-upload.dto.ts` (`@IsString() @IsNotEmpty()` title, fileName, contentType; `@IsNumber()` fileSize), `upload-parts.dto.ts` (`@IsString()` uploadId, `@IsArray()` partNumbers), `complete-upload.dto.ts` (`@IsString()` uploadId, `@IsArray()` parts with partNumber + etag)
- The authenticated user's channel id is resolved from `@CurrentUser()` → the user's channel (looked up via the channel's `user_id`); the video is always created under that channel

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | `POST /videos/uploads` 201 with draft video (auth), 401 without token; `POST /videos/uploads/:id/parts` returns presigned URLs; `POST /videos/uploads/:id/complete` enqueues job; `GET /videos/:id` 200 (public) |

**Dependencies:** SI-03.5

**Acceptance criteria:**

- `POST /videos/uploads` with a valid access token returns 201 with `{ videoId, uploadId, storageKey }` and persists a `draft` video under the authenticated user's channel
- Upload/complete endpoints return 401 without a valid access token (protected by global `JwtAuthGuard`)
- `GET /videos/:id` returns video metadata without authentication (public read for status polling)

---

### SI-03.7 — Streaming and Download (Range Requests)

**Description:** Implement the streaming/download endpoint that proxies the video object from storage, honoring `Range` headers (206 Partial Content) for streaming and full delivery (200) for download.

**Technical actions:**

- Implement `streamVideo(id, range: string | undefined)` in `VideosService` — load the video (must be `ready`), call `storageService.getObject(video.storageKey, range)`, and return the stream + metadata
- Add `GET /videos/:id/stream` to `VideosController` (`@Public()` — anonymous viewing per project plan; the video is streamed by URL). Set headers: `Content-Type` from the stored content type, `Accept-Ranges: bytes`, `Content-Length` (or `Content-Range` for partial). Return a `StreamableFile` (from `@nestjs/common`) wrapping the S3 body stream. If `range` is present and honored, respond `206 Partial Content` with `Content-Range: bytes start-end/total`; otherwise `200`
- If the video status is not `ready`, return 404 (or 409 for `processing`)
- Download is the same endpoint: a request without `Range` returns the full object (`Content-Disposition: attachment` optional, but full-body 200 satisfies "download")

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `src/videos/videos.service.spec.ts` | Unit | `streamVideo` calls `getObject` with the range, returns stream + headers; rejects non-ready videos |
| `test/videos.e2e-spec.ts` | E2E | `GET /videos/:id/stream` with `Range: bytes=0-99` returns 206 with `Content-Range`; without `Range` returns 200 full body |

**Dependencies:** SI-03.3, SI-03.6

**Acceptance criteria:**

- `GET /videos/:id/stream` with a `Range` header returns `206 Partial Content` with `Content-Range` and only the requested bytes — the video starts playing without downloading the whole file
- `GET /videos/:id/stream` without a `Range` header returns `200` with the full object — enabling download
- A non-`ready` video returns 404/409 and does not stream

---

### SI-03.8 — Worker Container and FFmpeg Integration Wiring

**Description:** Finalize the `video-worker` container so it runs the BullMQ processor (FFmpeg available) and consumes the same queue the API produces to. Wire the worker entrypoint and confirm end-to-end processing in the Compose stack.

**Technical actions:**

- Create `nestjs-project/worker/worker-main.ts` — standalone entrypoint that instantiates a `Worker` from `bullmq` (or reuses the NestJS `BullModule` via a small bootstrap) connecting to Redis at `queueConfig`, registering the `video-processing` queue processor. The worker shares the `Video` entity + `StorageService` + FFmpeg logic (imported from `src/videos/`)
- Update `nestjs-project/worker/Dockerfile.worker` — `CMD` runs the worker entrypoint (e.g., `node worker/worker-main.js` compiled, or `npm run start:worker`)
- Update `nestjs-project/compose.yaml` — `video-worker` service builds `worker/Dockerfile.worker`, mounts the same source, depends on Redis + MinIO healthy, shares env (Redis/S3)
- Add npm script `start:worker` in `package.json` pointing at the worker entrypoint

**Tests:**

| File | Layer | Verifies |
|------|-------|----------|
| `test/videos.e2e-spec.ts` | E2E | End-to-end: upload (presigned) → complete → worker processes → video reaches `ready` with duration + thumbnail populated (exercises real MinIO + Redis + FFmpeg) |

**Dependencies:** SI-03.4, SI-03.6

**Acceptance criteria:**

- The `video-worker` container runs the processor consuming the `video-processing` queue
- An end-to-end flow (initiate → complete → worker) transitions a video from `draft` to `ready` with `duration` and `thumbnail_key` populated in the DB
- The FFmpeg/ffprobe binaries are present in the worker container

---

## Technical Specifications

### Data Model

#### Video

| Column | Type | Constraints | Notes |
|--------|------|-------------|-------|
| id | uuid | PK, generated | Doubles as the public URL identifier (TD-06) |
| channel_id | uuid | FK → channels.id, not null | Owning channel (many videos per channel) |
| title | varchar | not null | Video title |
| status | enum | not null, default `'draft'`, values: `'draft'`, `'processing'`, `'ready'`, `'error'` | PostgreSQL enum `videos_status_enum` |
| storage_key | varchar | not null | Object key in the video bucket (e.g. `videos/{id}/original`) |
| thumbnail_key | varchar | nullable | Object key in the thumbnail bucket (e.g. `thumbnails/{id}/thumbnail.png`) |
| duration | integer | nullable | Seconds, filled by the worker (ffprobe) |
| metadata | jsonb | nullable | `{ width, height, codec_name, ... }` filled by the worker |
| error_message | text | nullable | Set on processing failure |
| created_at | timestamp | not null, auto-generated | `@CreateDateColumn` |
| updated_at | timestamp | not null, auto-generated | `@UpdateDateColumn` |

**Relations:** Video → Channel (many-to-one, owning side via `channel_id`)
**Indexes:** `(channel_id)` — FK; the enum `videos_status_enum` for `status`

**Status lifecycle (TD-07):** `draft` (initiate) → `processing` (worker) → `ready` (success) | `error` (failure).

---

### API Contracts

#### POST /videos/uploads (SI-03.6)

**Request headers:** `Authorization: Bearer <access_token>`, `Content-Type: application/json`

**Request body:**
- title: string, required
- fileName: string, required
- contentType: string, required
- fileSize: number, required

**Response 201:**
- videoId: string (uuid)
- uploadId: string (multipart upload id)
- storageKey: string

**Error responses:**
- 401: missing/invalid access token
- 400 VALIDATION_ERROR: when the body fails schema validation

---

#### POST /videos/uploads/:videoId/parts (SI-03.6)

**Request headers:** `Authorization: Bearer <access_token>`

**Request body:**
- uploadId: string, required
- partNumbers: number[], required

**Response 200:**
- parts: `[{ partNumber: number, url: string }]` (presigned UploadPart URLs)

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: unknown videoId

---

#### POST /videos/uploads/:videoId/complete (SI-03.6)

**Request headers:** `Authorization: Bearer <access_token>`

**Request body:**
- uploadId: string, required
- parts: `[{ partNumber: number, etag: string }]`, required

**Response 200:** the video object (id, title, status = `draft` pending worker)

**Error responses:**
- 401: missing/invalid access token
- 404 VIDEO_NOT_FOUND: unknown videoId

---

#### GET /videos/:id (SI-03.6)

**Response 200:**
- id, title, status, duration, thumbnail_key (when ready)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown id

---

#### GET /videos/:id/stream (SI-03.7)

**Request headers:** optional `Range: bytes=start-end`

**Response 206 (partial):** `Content-Range: bytes start-end/total`, `Accept-Ranges: bytes`, `Content-Type`, streamed partial body
**Response 200 (full):** full object body (download)

**Error responses:**
- 404 VIDEO_NOT_FOUND: unknown id
- 409 VIDEO_NOT_READY: video status is not `ready`

---

### Authorization Matrix

| Endpoint | Public | Authenticated | Notes |
|----------|--------|---------------|-------|
| POST /videos/uploads | | ✓ | Video created under the authenticated user's channel |
| POST /videos/uploads/:videoId/parts | | ✓ | |
| POST /videos/uploads/:videoId/complete | | ✓ | |
| GET /videos/:id | ✓ | | Public metadata read (status polling) |
| GET /videos/:id/stream | ✓ | | Anonymous viewing per project plan; streamed by unique URL |

---

### Error Catalog

**Error response format:** `{ statusCode, error, message }` (inherited from Phase 02).

| Code | HTTP | Message | Trigger |
|------|------|---------|---------|
| VIDEO_NOT_FOUND | 404 | Video not found | GET/POST with an unknown video id |
| VIDEO_NOT_READY | 409 | Video is not ready | GET /videos/:id/stream when status != ready |
| VALIDATION_ERROR | 400 | array of field errors | DTO validation failure |

Worker processing failures do not produce HTTP errors — they persist `status = 'error'` + `error_message` on the video row (observable via `GET /videos/:id`).

---

### Events / Messages

The queue is the messaging surface for this phase. Jobs are JSON-serializable (they carry the video id, not the file).

| Queue | Job name | Payload | Producer | Consumer |
|-------|----------|---------|----------|----------|
| `video-processing` | `process-video` | `{ videoId: string }` | `VideosService.completeUpload` (SI-03.5) | `VideoProcessingProcessor` in the `video-worker` container (SI-03.4/SI-03.8) |

**Retry policy:** `attempts: 3`, exponential `backoff`. On final failure, the processor persists `status = 'error'` + `error_message` and rethrows so BullMQ records the failed job.

---

## Dependency Map

```
SI-03.1 (no deps)
├── SI-03.2
├── SI-03.3
└── SI-03.4 (needs SI-03.2 + SI-03.3)

SI-03.2 + SI-03.3 + SI-03.4
└── SI-03.5

SI-03.5
└── SI-03.6

SI-03.3 + SI-03.6
└── SI-03.7

SI-03.4 + SI-03.6
└── SI-03.8
```

Linearized implementation order: SI-03.1 → SI-03.2, SI-03.3 (parallel) → SI-03.4 → SI-03.5 → SI-03.6 → SI-03.7, SI-03.8 (parallel)

## Deliverables

- [ ] MinIO (object storage), Redis (queue backend), and `video-worker` (FFmpeg) services running in Docker Compose alongside the API
- [ ] `Video` entity linked to `Channel`, with status lifecycle enum, storage keys, duration, metadata, and unique uuid public id; migration created
- [ ] `StorageService` with presigned PUT/multipart upload, complete/abort, range-based `GetObject`, and object existence
- [ ] BullMQ queue (`video-processing`) with `process-video` job; `VideoProcessingProcessor` (ffprobe metadata extraction + ffmpeg thumbnail generation + status transitions)
- [ ] Upload orchestration endpoints: initiate (draft pre-registration) → presigned parts → complete (enqueue processing)
- [ ] Streaming/download endpoint honoring `Range` (206 Partial Content) and full-body (200) delivery
- [ ] Status lifecycle `draft → processing → ready | error` reflected in the database
- [ ] Upload of files up to 10GB via presigned multipart — the byte stream never passes through the API
- [ ] Unique video URL via uuid id (`GET /videos/:id` and `GET /videos/:id/stream`)
- [ ] Worker container with FFmpeg/ffprobe installed, consuming the same queue the API produces to
- [ ] All SI tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation check passes (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)
