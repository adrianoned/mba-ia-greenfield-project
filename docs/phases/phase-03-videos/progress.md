# phase-03-videos — Progress

**Status:** completed
**SIs:** 8/8 completed

### SI-03.1 — Dependencies, Configuration Namespaces, and Docker Compose Infrastructure
- **Status:** completed
- **Tests:** 64/64 unit passing; `npx tsc --noEmit` exit 0; infra (minio/redis/video-worker) healthy
- **Observations:** `@nestjs/bullmq@12` é ESM-only e quebra o Jest (ts-jest/CommonJS) — rebaixado para `@11.0.5` (CJS). `ioredis@6` conflita com `typeorm@0.3.28` (peerOptional `ioredis@^5`) — fixado `ioredis@^5.11.1`. A imagem oficial `minio/minio` foi removida do Docker Hub e `quay.io/minio/minio` retorna 401 — usado `elestio/minio` (binário MinIO RELEASE.2025-09-07, com `curl` para healthcheck).

### SI-03.2 — Video Entity and Migration
- **Status:** completed
- **Tests:** 6/6 passing (video.entity.integration-spec.ts: 5, videos.module.spec.ts: 1)
- **Observations:** PostgreSQL não cria índice automático para FK — adicionado `@Index()` em `channel_id`. Migration `1795631156556-CreateVideos.ts` cria o enum `videos_status_enum`. `migrations.integration-spec.ts` atualizado para registrar a entidade `Video`, a migration `CreateVideos` e dropar o enum `videos_status_enum` no `beforeAll` (o `DROP TABLE ... CASCADE` não dropa enum types).

### SI-03.3 — Storage Service (S3/MinIO + Presigned URLs)
- **Status:** completed
- **Tests:** 8/8 passing (storage.service.spec.ts)
- **Observations:** `StorageService` cria os buckets `videos` e `thumbnails` no `onModuleInit` (idempotente via `HeadBucket`/`CreateBucket`) — o MinIO sobe sem buckets e o `CreateMultipartUpload` falharia com 500 sem isso. `GetObjectCommandOutput.Body` é `Readable` (node:stream), não `NodeJS.ReadableStream` — o `StreamableFile` do Nest exige `Readable`.

### SI-03.4 — Queue Module and Video Processor (Worker)
- **Status:** completed
- **Tests:** 3/3 passing (video-processing.processor.spec.ts)
- **Observations:** `@nestjs/bullmq` usa `@Processor(name)` + `WorkerHost.process(job)` (não há `@Process(name)` como no Bull legado). O processor baixa o objeto para temp file, extrai duração/resolução/codec via `ffprobe`, gera thumbnail via `ffmpeg.screenshots()`, sobe para o bucket `thumbnails` e transiciona `draft → processing → ready` (ou `error` com `error_message` em falha). `fluent-ffmpeg` é um wrapper do binário — a imagem do worker precisa de `ffmpeg`/`ffprobe` instalados.

### SI-03.5 — Videos Service (Upload Orchestration and Status Lifecycle)
- **Status:** completed
- **Tests:** 7/7 passing (videos.service.spec.ts: 5 unit, videos.service.integration-spec.ts: 2 integration)
- **Observations:** `initiateUpload` faz dois saves (o UUID público só é conhecido após o primeiro insert — a `storage_key` deriva dele). O `uploadId` do multipart não é persistido (o estado fica no MinIO); o cliente o reenvia no complete. `completeUpload` enfileira `process-video` via BullMQ.

### SI-03.6 — Videos Controller (Initiate/Complete Upload and Status)
- **Status:** completed
- **Tests:** 168/168 unit+integration; 57/57 e2e (test/videos.e2e-spec.ts exercita MinIO real)
- **Observations:** Endpoints de upload protegidos pelo guard JWT global; `@Public()` em `GET /videos/:id` (metadata) e `GET /videos/:id/stream`. O channel do usuário é resolvido via `ChannelsService.findByUserId(user.sub)` (método adicionado). Erros de domínio `VideoNotFoundException`/`VideoNotReadyException`/`ChannelNotFoundException` mapeados pelo `DomainExceptionFilter`.

### SI-03.7 — Streaming and Download (Range Requests)
- **Status:** completed
- **Tests:** e2e confirma `206 Partial Content` com `Content-Range` (Range) e `200` full body (download)
- **Observations:** `GET /videos/:id/stream` seta `Accept-Ranges: bytes`, `Content-Type`, `Content-Range`/`Content-Length` e retorna `StreamableFile` do stream do MinIO. Validação manual: `Range: bytes=0-99` → 206 com `Content-Range: bytes 0-99/42252`.

### SI-03.8 — Worker Container and FFmpeg Integration Wiring
- **Status:** completed
- **Tests:** end-to-end manual (upload real → worker processa → `draft`→`ready` com `duration=3`, `metadata={width:320,height:240,codec_name:h264}` e `thumbnail_key` preenchido); `npm run build` exit 0 (dist/worker-main.js)
- **Observations:** `src/worker-main.ts` usa `NestFactory.createApplicationContext(AppModule)` (sem HTTP) — o `VideoProcessingProcessor` (`@Processor`) começa a consumir a fila imediatamente. Script `npm run start:worker` via `ts-node`; o container `video-worker` sobe com `command: npm run start:worker` no compose.
