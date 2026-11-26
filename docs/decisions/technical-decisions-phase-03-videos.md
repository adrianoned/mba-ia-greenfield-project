---
scope_type: phase
related_phases: [3]
status: decided
date: 2026-11-25
scope_description: "Fase 03 — Upload e Processamento de Vídeos: tecnologia de fila, estratégia de upload de até 10GB sem travar a API, uso do object storage (S3/MinIO) com upload pré-assinado, worker de processamento (FFmpeg/ffprobe) e geração de thumbnail, ciclo de status do vídeo, URL única e streaming/download via range requests."
---

# Technical Decisions — Phase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — módulo de vídeos, entidade/tabela, fila, worker, storage e streaming; a infraestrutura nova (MinIO, Redis, worker) sobe junto na stack do backend.
- `next-frontend/` — **fora do escopo desta fase.** O enunciado é explícito: "a interface de vídeo não faz parte do escopo desta fase". Nenhuma decisão de frontend neste documento; as decisões aqui são todas de backend/infra e o frontend só as consumirá em fases futuras.

---

## TD-01: Message Queue Technology

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** A arquitetura-alvo (`docs/diagrams/software-arch.mermaid`) prevê uma *Message Queue* para o processamento de vídeos, mas o `project-plan.md` deixa a tecnologia explicitamente em aberto ("TBD"). É a principal decisão de stack da fase. A fila desacopla o upload (síncrono, na API) do processamento pesado (FFmpeg, no worker), permitindo processar vídeos de até 10GB sem bloquear a API.

**Options:**

### Option A: BullMQ + Redis
- Biblioteca de filas baseada em Redis, com integração oficial no NestJS via `@nestjs/bullmq`. Proporciona workers, retry com backoff, prioridades, eventos e delayed jobs.
- **Pros:** integração oficial e documentada no NestJS (docs "Queues"); ativamente desenvolvida (Bull está em maintenance mode); Redis já é um componente barato e amplamente usado; suporta retry/backoff e reexecução de jobs de processamento falhos — essencial para o worker de vídeo; `@Processor` + `WorkerHost` simplificam o consumidor.
- **Cons:** adiciona o Redis como dependência de infra nova (mais um container no Compose); fila não persistente por padrão se o Redis não estiver configurado com `appendonly`; o job payload fica limitado a JSON serializável (não carrega o arquivo em si — só metadados/chaves de storage, o que é correto aqui).

### Option B: Bull (mantido)
- Predecessor do BullMQ, mesma API conceitual, também Redis-backed, integração NestJS via `@nestjs/bull`.
- **Pros:** documentação e exemplos abundantes; API familiar.
- **Cons:** está em *maintenance mode* — sem novas features; desaconsejado para greenfield em 2026; `@nestjs/bull` herdará as mesmas limitações.

### Option C: RabbitMQ (AMQP)
- Message broker de propósito geral, protocolo AMQP, com trocas/roteamento complexos.
- **Pros:** robusto para roteamento avançado e múltiplos consumidores heterogêneos; persistência forte.
- **Cons:** operação e imagem Docker mais pesadas que Redis; o projeto tem um único produtor/consumidor de um único tipo de job (processar vídeo) — o roteamento AMQP é overkill; integração NestJS é mais verbosa que `@nestjs/bullmq`.

**Recommendation:** **Option A (BullMQ + Redis)** — a integração oficial no NestJS, o suporte a retry/backoff (necessário para reprocessar vídeos que falhem) e o modelo single-producer/single-consumer do caso resolvem o problema sem a complexidade do RabbitMQ. Redis é leve o suficiente para subir como container adicional no Compose e já é o padrão de fato para filas de processamento em stacks NestJS.

**Decision:** A (BullMQ + Redis)

---

## TD-02: Upload Strategy for Large Files (up to 10GB)

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** O requisito crítico é "upload de até 10GB sem travar o sistema". Passar o arquivo inteiro pela API (multipart via multer, lendo tudo em memória ou mesmo em disco no container da API) é o caminho errado — o enunciado reprova explicitamente "passar o arquivo de 10GB pela API de forma que trave o sistema". É preciso uma estratégia em que o cliente envie o arquivo **diretamente ao object storage**, sem atravessar a API.

**Options:**

### Option A: Upload direto ao storage via URL pré-assinada (presigned URL)
- A API gera uma URL pré-assinada S3 (`PutObject`) para uma chave de storage; o cliente faz `PUT` direto ao MinIO com o arquivo. Para arquivos grandes, usa multipart presignado: `CreateMultipartUpload` (server-side) → `UploadPart` pré-assinado por parte → `CompleteMultipartUpload` (server-side, com os ETags).
- **Pros:** o byte stream nunca passa pela API — zero impacto de memória/CPU na API; aproveita o upload multipart nativo do S3/MinIO (retomável, paralelizável); o frontend pode usar o SDK S3 ou `fetch` para o PUT; escala para 10GB sem esforço adicional; é o padrão recomendado pela AWS para objetos grandes.
- **Cons:** o fluxo é multi-etapa (iniciar upload → partes → completar), exigindo endpoints de orquestração e o registro do estado do upload; a URL pré-assinada expira (precisa renovação se o upload for lento).

### Option B: Multipart chunked via API (chunks pela API e re-montagem no storage)
- O cliente envia o arquivo em chunks para a API; a API repassa cada chunk ao storage e monta o objeto ao final.
- **Pros:** a API mantém controle total do fluxo.
- **Cons:** o arquivo inteiro **ainda atravessa a API**, mesmo que em pedaços — viola o requisito de "não travar a API"; consome CPU/rede/IO do container da API para 10GB por upload.

### Option C: Protocolo tus (tus.io) para upload retomável
- Protocolo open-source de upload retomável (`tus`), com clientes e servidores dedicados.
- **Pros:** retomada de upload nativa e robusta; ideal para conexões instáveis.
- **Cons:** introduz um servidor/protocolo adicional não previsto na arquitetura; o S3/MinIO já oferece multipart retomável nativamente, tornando o tus redundante; integração NestJS menos direta.

**Recommendation:** **Option A (presigned URL + multipart)** — mantém o arquivo fora da API (atende o requisito anti-trava), reutiliza o multipart nativo do S3/MinIO para arquivos grandes e retomáveis, e é o padrão da AWS. O fluxo de orquestração (iniciar → completar) é resolvido com endpoints no módulo de vídeos; a pré-cadastro do rascunho acontece na etapa de "iniciar upload".

**Decision:** A (Presigned URL + multipart direto ao storage)

---

## TD-03: Object Storage Usage (MinIO / S3)

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O storage **não é uma escolha em aberto** — o projeto já aponta para S3-compatível, rodando MinIO localmente em Docker (mesma API do S3), trocável por S3 em produção. O que se decide aqui é **como usá-lo**: SDK, organização de buckets/chaves e o mecanismo de geração de URLs pré-assinadas (para upload — TD-02 — e para leitura/streaming — TD-05).

**Options:**

### Option A: `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner` (S3 SDK v3)
- Usa o SDK oficial AWS S3 v3, que é compatível com o endpoint S3 do MinIO configurando `endpoint` e `forcePathStyle: true`.
- **Pros:** SDK oficial e estável; `getSignedUrl` para PUT/GET; suporte completo a multipart (`CreateMultipartUpload`/`UploadPart`/`CompleteMultipartUpload`); sem vendor lock-in — trocar MinIO por S3 é só mudar `endpoint`/credenciais.
- **Cons:** adiciona duas dependências (`@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`); a configuração de `endpoint`/`forcePathStyle` é específica de S3-compatível (precisa ficar clara no config).

### Option B: `minio` (SDK nativo do MinIO)
- Usa o SDK `minio` oficial, que implementa a API S3 voltada ao MinIO.
- **Pros:** API voltada ao MinIO; simples.
- **Cons:** acopla o código ao MinIO; trocar por S3 em produção exigiria trocar o SDK; o SDK `minio` tem menos tração em produção S3 que o SDK AWS.

### Option C: `@nestjs/storage` (abstração de storage da NestJS)
- Abstração oficial da NestJS sobre múltiplos backends de storage.
- **Pros:** desacopla o backend do storage concreto.
- **Cons:** menos controle sobre presigned multipart (necessário no TD-02); camada de abstração extra quando o projeto já decidiu por S3-compatível.

**Recommendation:** **Option A (`@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`)** — SDK oficial S3, compatível com MinIO via `endpoint`+`forcePathStyle`, com suporte completo a presigned URL e multipart (necessários nos TD-02 e TD-05), e troca transparente para S3 em produção. Organização: buckets separados `videos` e `thumbnails` (ou prefixos dentro de um bucket), com chaves derivadas do identificador único do vídeo (TD-06).

**Decision:** A (@aws-sdk/client-s3 + s3-request-presigner)

---

## TD-04: Video Worker & Processing (FFmpeg / ffprobe)

**Scope:** Backend

**Capability:** Processamento automático do vídeo após upload (extração de duração e metadados)

**Context:** Após o upload, um worker consome o job da fila (TD-01) e processa o vídeo: extrai duração/metadados (ffprobe) e gera um thumbnail a partir de um frame (ffmpeg). O worker roda como processo/container separado, fora da API. Decide-se **como** invocar o FFmpeg e **onde** o worker vive.

**Options:**

### Option A: `fluent-ffmpeg` (wrapper Node sobre o binário ffmpeg/ffprobe)
- Wrapper fluente que abstrai a CLI do ffmpeg; `ffmpeg.ffprobe()` extrai metadados (duração, resolução, codec); `.screenshots()` gera thumbnails.
- **Pros:** API fluente e testável em Node; `ffprobe` retorna objeto estruturado com duração/`width`/`height`/codec; `.screenshots()` resolve o thumbnail de forma direta; amplamente usado.
- **Cons:** depende dos binários `ffmpeg`/`ffprobe` instalados no container do worker (imagem base precisa incluí-los); é um wrapper de subprocess — o FFmpeg em si precisa estar presente.

### Option B: Chamada direta ao binário `ffmpeg`/`ffprobe` via `child_process`
- Invoca `ffmpeg`/`ffprobe` diretamente com argumentos de CLI.
- **Pros:** zero dependência extra; controle total dos argumentos.
- **Cons:** parsing manual da saída do ffprobe; mais propenso a erros; mais boilerplate que `fluent-ffmpeg`.

### Option C: `ffmpeg.wasm`
- FFmpeg compilado para WebAssembly, roda dentro do Node sem binário externo.
- **Pros:** sem binário externo; portátil.
- **Cons:** performance muito inferior ao FFmpeg nativo para vídeos grandes (10GB inviável); consumo de memória alto; não adequado para este caso de uso.

**Recommendation:** **Option A (`fluent-ffmpeg` sobre binários FFmpeg/ffprobe)** — a extração estruturada de metadados via `ffprobe` e a geração de thumbnail via `.screenshots()` cobrem exatamente os dois requisitos com o mínimo de boilerplate. O worker roda como container Docker separado com FFmpeg instalado na imagem, consumindo a fila (TD-01); a API nunca executa FFmpeg.

**Decision:** A (fluent-ffmpeg + ffprobe, worker em container com FFmpeg)

---

## TD-05: Streaming & Download Strategy

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** O vídeo deve ser reproduzível via streaming (iniciar sem baixar o arquivo inteiro) e baixável pelo usuário. O arquivo está no object storage (TD-03). Decide-se o mecanismo de entrega do vídeo ao cliente.

**Options:**

### Option A: HTTP Range requests (206 Partial Content) via proxy da API para o storage
- O endpoint de streaming da API expõe o vídeo e honra cabeçalhos `Range`/`Accept-Ranges`, fazendo proxy do objeto no storage (via `getSignedUrl` GET ou leitura por range). Retorna `206 Partial Content` com `Content-Range`.
- **Pros:** é o mecanismo padrão de streaming de vídeo na web (players HTML5 e navegadores já enviam `Range`); permite seek/retomada; a API mantém controle de acesso (autorização) e a URL real do storage não vaza; funciona para download também (sem `Range`, entrega o objeto completo).
- **Cons:** a API faz proxy dos bytes (sobrecarga de rede no container), a menos que se redirecione para uma presigned GET URL.

### Option B: Presigned GET URL redirecionada diretamente ao storage
- A API gera uma URL pré-assinada de GET e redireciona (302) o cliente ao storage; o storage entrega o vídeo com suporte a range nativo.
- **Pros:** bytes não passam pela API; MinIO/S3 suporta range nativo.
- **Cons:** a URL pré-assinada expira e expõe o storage; controle de autorização fica só na geração da URL (ok, mas menos flexível para políticas granulares); o cliente precisa seguir o redirect.

**Recommendation:** **Option A (range requests via proxy da API)** — mantém o controle de autorização na API e expõe um endpoint estável de streaming/download por URL única, delegando o suporte a `Range`/`206` ao objeto do storage lido por faixa. Para otimizar, a leitura pode usar a presigned GET URL server-side e repassar os ranges; o download é o mesmo endpoint sem `Range`.

**Decision:** A (HTTP Range requests via proxy da API)

---

## TD-06: Unique Video URL Identifier

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** Cada vídeo precisa de uma URL curta e única que nunca conflite. O identificador é usado na chave de storage (TD-03) e no endpoint público (TD-05). Decide-se o formato/geração do identificador.

**Options:**

### Option A: ULID (Universally Unique Lexicographically Sortable Identifier)
- Identificador de 26 caracteres, ordenável por tempo, com aleatoriedade (80 bits) para unicidade.
- **Pros:** curto, URL-safe, unicidade garantida por entropia; ordenável (facilita indexação); sem colisão prática.
- **Cons:** dependência adicional (`ulid`).

### Option B: UUID v4
- Identificador padrão de 36 caracteres (128 bits).
- **Pros:** nativo em Postgres (`uuid_generate_v4()`, já usado no projeto via `uuid-ossp`); zero dependência nova; unicidade garantida.
- **Cons:** mais longo que ULID; não ordenável por tempo (menos relevante para chave de storage).

### Option C: Nanoid
- Identificador curto customizável, URL-safe.
- **Pros:** muito curto e URL-safe.
- **Cons:** dependência adicional; menor garantia formal de unicidade que ULID/UUID; não ordenável.

**Recommendation:** **Option B (UUID v4)** — o projeto já usa UUID como chave primária (`uuid-ossp` ativado, entidades `users`/`channels` com `uuid_generate_v4()`), então reusar UUID para o identificador público do vídeo evita dependência nova e mantém consistência. A chave de storage deriva do UUID (ex.: `videos/{uuid}/original`), garantindo URL única sem colisão.

**Decision:** B (UUID v4)

---

## TD-07: Video Status Lifecycle

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** A entidade de vídeos precisa de um ciclo de status refletido no banco: o upload inicia com pré-cadastro em `draft` (rascunho), passa a `processing` quando o worker processa, e termina em `ready` ou `error` conforme o resultado do processamento. Decide-se o conjunto de estados e a semântica de transição.

**Options:**

### Option A: Ciclo enxuto `draft → processing → ready | error`
- Quatro estados: `draft` (pré-cadastrado no upload), `processing` (worker em execução), `ready` (processado com sucesso), `error` (falha no processamento).
- **Pros:** cobre exatamente os estados descritos no enunciado ("rascunho → processando → pronto/erro"); simples de modelar como `enum` no TypeORM; o campo de status é facilmente indexável e consultável.
- **Cons:** não distingue "upload ainda em andamento" de "draft finalizado" (o draft cobre ambos); não tem estado explícito de "enfileirado" separado de "processando" (ambos sob `processing` ou o worker seta `processing` ao consumir).

### Option B: Ciclo estendido `draft → queued → processing → ready | error`
- Adiciona `queued` (job enfileirado, ainda não consumido) entre `draft` e `processing`.
- **Pros:** visibilidade fina da posição do job na fila.
- **Cons:** mais estados que o necessário para o requisito; `queued` é inferível do job na fila (BullMQ já rastreia); adiciona complexidade de transição.

### Option C: Ciclo com `published/unlisted` incorporado
- Mistura status de processamento com status de visibilidade (público/unlisted da Fase 04).
- **Pros:** —
- **Cons:** mistura duas dimensões (estado de processamento vs. visibilidade) que a Fase 04 trata separadamente; foge do escopo da Fase 03.

**Recommendation:** **Option A (`draft → processing → ready | error`)** — é o ciclo exato do enunciado. O worker transiciona `draft → processing → ready` no sucesso e `draft → processing → error` na falha (com o campo de erro registrado); em caso de falha, o job pode ser reenfileirado via retry da fila (TD-01). Visibilidade (`public/unlisted`) é dimensão da Fase 04 e não entra aqui.

**Decision:** A (draft → processing → ready | error)

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Message Queue Technology | BullMQ + Redis | A |
| TD-02 | Backend | Upload Strategy (10GB) | Presigned URL + multipart direto ao storage | A |
| TD-03 | Backend | Object Storage Usage | `@aws-sdk/client-s3` + presigner (MinIO via endpoint/forcePathStyle) | A |
| TD-04 | Backend | Video Worker & Processing | `fluent-ffmpeg` + ffprobe (worker em container com FFmpeg) | A |
| TD-05 | Backend | Streaming & Download | HTTP Range requests via proxy da API | A |
| TD-06 | Backend | Unique Video URL | UUID v4 (reuso do padrão do projeto) | B |
| TD-07 | Backend | Video Status Lifecycle | `draft → processing → ready \| error` | A |
