---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-25T11:23:57-0300"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-25T14:15:09-0300"
  docs/decisions/technical-decisions-phase-01-configuracao-base.md: "2026-11-25T11:59:13-0300"
  docs/phases/phase-01-configuracao-base/phase-01-configuracao-base.md: "2026-11-25T11:23:57-0300"
---

# phase-03-videos — Context

## Scope

**Phase name:** Fase 03 — Upload e Processamento de Vídeos

**Capabilities**

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** Edição de informações do vídeo, categorias, visibilidade público/unlisted, painel de gerenciamento do canal, página pública do canal (Fase 04); player e página de visualização (Fase 05); likes/comentários/inscrições (Fase 06); home/busca (Fase 07). A interface de vídeo no frontend não faz parte desta fase.

**Deliverables:** upload de até 10GB funcional (presigned direto ao storage), processamento automático do vídeo (ffprobe/ffmpeg no worker), thumbnail gerada, streaming funcionando (range requests) e URLs únicas geradas.

**Affected subprojects:** `nestjs-project/`

**Deferred subprojects:** `next-frontend/` — a interface de vídeo fica fora do escopo desta fase; o frontend só consumirá os endpoints de vídeo em fases futuras.

**Sequencing notes:** Depends on Fase 01 (config base) e Fase 02 (auth — usuários, canais e guard JWT global).

**Neighbors (for boundary detection only):** Fase 02 (prior), Fase 04 — Gerenciamento de Vídeos e Canal (next).

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | technical-decisions-phase-03-videos.md | Backend | Message Queue Technology | decided | A (BullMQ + Redis) | @nestjs/bullmq@^11.x, bullmq@^6.x, ioredis@^5.x |
| phase-03-videos/TD-02 | technical-decisions-phase-03-videos.md | Backend | Upload Strategy (10GB) | decided | A (Presigned URL + multipart direto ao storage) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-03 | technical-decisions-phase-03-videos.md | Backend | Object Storage Usage | decided | A (@aws-sdk/client-s3 + presigner) | @aws-sdk/client-s3@^3.x, @aws-sdk/s3-request-presigner@^3.x |
| phase-03-videos/TD-04 | technical-decisions-phase-03-videos.md | Backend | Video Worker & Processing | decided | A (fluent-ffmpeg + ffprobe) | fluent-ffmpeg@^2.x |
| phase-03-videos/TD-05 | technical-decisions-phase-03-videos.md | Backend | Streaming & Download | decided | A (HTTP Range requests via proxy da API) | — |
| phase-03-videos/TD-06 | technical-decisions-phase-03-videos.md | Backend | Unique Video URL | decided | B (UUID v4) | — |
| phase-03-videos/TD-07 | technical-decisions-phase-03-videos.md | Backend | Video Status Lifecycle | decided | A (draft → processing → ready \| error) | — |

_Source files:_

- `docs/decisions/technical-decisions-phase-03-videos.md`

## Capability Coverage

| Capability | Covered by |
|------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-03 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-02 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-02, phase-03-videos/TD-07 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-04 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-04 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-06 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-05 |
| Download do vídeo pelo usuário | phase-03-videos/TD-05 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** Option A (BullMQ + Redis) — a integração oficial no NestJS, o suporte a retry/backoff (necessário para reprocessar vídeos que falhem) e o modelo single-producer/single-consumer do caso resolvem o problema sem a complexidade do RabbitMQ. Redis é leve o suficiente para subir como container adicional no Compose.

**Libraries:** `@nestjs/bullmq@^11.x`, `bullmq@^6.x`, `ioredis@^5.x`

### phase-03-videos/TD-02

**Recommendation:** Option A (presigned URL + multipart) — mantém o arquivo fora da API (atende o requisito anti-trava), reutiliza o multipart nativo do S3/MinIO para arquivos grandes e retomáveis, e é o padrão da AWS. O fluxo de orquestração (iniciar → completar) é resolvido com endpoints no módulo de vídeos; o pré-cadastro do rascunho acontece na etapa de "iniciar upload".

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-03

**Recommendation:** Option A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`) — SDK oficial S3, compatível com MinIO via `endpoint`+`forcePathStyle`, com suporte completo a presigned URL e multipart, e troca transparente para S3 em produção. Organização: buckets separados `videos` e `thumbnails`, com chaves derivadas do UUID do vídeo.

**Libraries:** `@aws-sdk/client-s3@^3.x`, `@aws-sdk/s3-request-presigner@^3.x`

### phase-03-videos/TD-04

**Recommendation:** Option A (`fluent-ffmpeg` sobre binários FFmpeg/ffprobe) — a extração estruturada de metadados via `ffprobe` e a geração de thumbnail via `.screenshots()` cobrem exatamente os dois requisitos com o mínimo de boilerplate. O worker roda como container Docker separado com FFmpeg instalado na imagem, consumindo a fila; a API nunca executa FFmpeg.

**Libraries:** `fluent-ffmpeg@^2.x`

### phase-03-videos/TD-05

**Recommendation:** Option A (range requests via proxy da API) — mantém o controle de autorização na API e expõe um endpoint estável de streaming/download por URL única, delegando o suporte a `Range`/`206` ao objeto do storage lido por faixa. O download é o mesmo endpoint sem `Range`.

**Libraries:** —

### phase-03-videos/TD-06

**Recommendation:** Option B (UUID v4) — o projeto já usa UUID como chave primária (`uuid-ossp` ativado), então reusar UUID para o identificador público do vídeo evita dependência nova e mantém consistência. A chave de storage deriva do UUID.

**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** Option A (`draft → processing → ready | error`) — é o ciclo exato do enunciado. O worker transiciona `draft → processing → ready` no sucesso e `draft → processing → error` na falha; em caso de falha, o job pode ser reenfileirado via retry da fila. Visibilidade (`public/unlisted`) é dimensão da Fase 04.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, zero custom wiring, native string-to-number coercion.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — Clear file boundaries per domain, typed injection via `ConfigType<typeof xxxConfig>`, natural scalability. The `registerAs()` factory is dual-purpose: DI token + plain importable function.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — `data-source.ts` imports the factory, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- Database connection parameters are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_
- Migrations are generated via TypeORM CLI and versioned; `synchronize: true` is never used; test data sources import entities explicitly (no globs) and pass migration classes directly. _(from phase 01)_
- Entities use `@Entity()`, uuid PK via `uuid_generate_v4()`, `@CreateDateColumn`/`@UpdateDateColumn`; modules follow the naming convention (`VideosModule`, `Video`). _(from phase 01/02)_
- Domain errors use `DomainException` subclasses with an `errorCode` + HTTP status, mapped by the global `DomainExceptionFilter` to `{ statusCode, error, message }`. _(from phase 02)_
- Auth is enforced by a global `JwtAuthGuard`; endpoints opt out via `@Public()`. The authenticated user is available via `@CurrentUser()`. _(from phase 02)_
- Videos belong to a channel (1:1 user→channel, created at registration); Phase 03 attaches videos to the channel via `channel_id`. _(from phase 02)_

## Inherited Deferred Capabilities

_No inherited deferred capabilities._

## Non-UI / Deferred Capabilities

| Capability | Status | Rationale | TD refs |
|------------|--------|-----------|---------|
| Reprodução via streaming e download na interface | deferred | A interface de vídeo no `next-frontend/` fica fora do escopo desta fase; os endpoints de streaming/download são backend-only e serão consumidos pelo frontend em fases futuras. | phase-03-videos/TD-05 |

## Testing Requirements

Refer to the `testing-guide-nestjs-project` Skill for layer requirements per artifact type in `nestjs-project/`. Phase 03 introduces entities (`Video`), a domain service (`VideosService`), a storage service (`StorageService`), a queue producer/consumer (BullMQ), a worker (FFmpeg), and HTTP endpoints — each layer is exercised by unit (`*.spec.ts`), integration (`*.integration-spec.ts`, real DB/MinIO/Redis), and E2E (`*.e2e-spec.ts`, supertest) tests per the testing guide's pyramid. Infra (MinIO, Redis, worker) is exercised for real via the Compose stack, not mocked.
