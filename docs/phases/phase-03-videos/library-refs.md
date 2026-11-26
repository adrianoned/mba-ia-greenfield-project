---
libs:
  "@nestjs/bullmq":
    version: "^11.0.5"
    context7_id: "/nestjs/nest"
    fetched_at: "2026-11-25T14:20:00-0300"
  "bullmq":
    version: "^6.7.10"
    context7_id: "/taskforcesh/bullmq"
    fetched_at: "2026-11-25T14:20:00-0300"
  "ioredis":
    version: "^5.11.1"
    context7_id: "/redis/ioredis"
    fetched_at: "2026-11-25T14:20:00-0300"
  "@aws-sdk/client-s3":
    version: "^3.1177.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-25T14:20:00-0300"
  "@aws-sdk/s3-request-presigner":
    version: "^3.1177.0"
    context7_id: "/aws/aws-sdk-js-v3"
    fetched_at: "2026-11-25T14:20:00-0300"
  "fluent-ffmpeg":
    version: "^2.1.3"
    context7_id: "/fluent-ffmpeg/node-fluent-ffmpeg"
    fetched_at: "2026-11-25T14:20:00-0300"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-25T14:15:09-0300"
---

# Library References — Phase 03

## @nestjs/bullmq

Integração oficial do BullMQ no NestJS. Registro de filas via `BullModule.forRoot({ connection: { host, port } })` + `BullModule.registerQueue({ name })`; produtor injeta a fila com `@InjectQueue(name)` e chama `queue.add(name, payload, opts)`; consumidor usa `@Processor(name)` estendendo `WorkerHost` com `process(job)`. Retry/backoff via `attempts`/`backoff` no job options. Referência: NestJS docs "Queues" (`@nestjs/bullmq`).

## bullmq

Fila baseada em Redis. `Queue.add`, `Worker`, retry com backoff, eventos, delayed jobs. Desde a 2.0 o `QueueScheduler` não é mais necessário para delayed jobs. O job payload é JSON-serializável (metadados/chaves de storage, não o arquivo).

## ioredis

Cliente Redis usado pelo BullMQ para conexão. `new IORedis({ host, port })` ou connection string. O container Redis sobe no Compose como serviço `redis`.

## @aws-sdk/client-s3

SDK AWS S3 v3, compatível com MinIO via `endpoint` + `forcePathStyle: true`. Comandos: `PutObject`, `GetObject`, `HeadObject`, `DeleteObject`, `CreateMultipartUpload`, `UploadPart`, `CompleteMultipartUpload`. O `GetObject` expõe um stream (`Body`) para proxy de range requests.

## @aws-sdk/s3-request-presigner

`getSignedUrl(client, command, { expiresIn })` gera URLs pré-assinadas para `PutObject`/`UploadPart` (upload direto) e `GetObject` (leitura). Presigned URLs expiram; o fluxo multipart presigna cada `UploadPart` com `UploadId` + `PartNumber`.

## fluent-ffmpeg

Wrapper Node sobre os binários `ffmpeg`/`ffprobe`. `ffmpeg.ffprobe(path)` retorna `{ format: { duration }, streams: [{ width, height, codec_name, ... }] }`. `.screenshots({ count, folder, size })` gera thumbnails. Requer `ffmpeg`/`ffprobe` instalados na imagem do worker.
