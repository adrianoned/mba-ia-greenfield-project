import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Job } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VIDEO_PROCESSING_QUEUE, VideoProcessJobPayload } from './videos.queue';

interface FfprobeStream {
  width?: number;
  height?: number;
  codec_name?: string;
}

@Injectable()
@Processor(VIDEO_PROCESSING_QUEUE)
export class VideoProcessingProcessor extends WorkerHost {
  private readonly logger = new Logger(VideoProcessingProcessor.name);

  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
  ) {
    super();
  }

  async process(job: Job<VideoProcessJobPayload>): Promise<void> {
    const { videoId } = job.data;
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      this.logger.warn(`Video ${videoId} not found — skipping stale job`);
      return;
    }

    video.status = VideoStatus.PROCESSING;
    await this.videoRepository.save(video);

    const tempDir = await mkdtemp(join(tmpdir(), 'streamtube-video-'));
    const tempFile = join(tempDir, 'source');

    try {
      const stored = await this.storageService.getObject(video.storage_key);
      await this.writeStreamToFile(stored.body, tempFile);

      const metadata = await this.probeMetadata(tempFile);
      video.duration = metadata.duration ?? null;
      video.metadata = {
        width: metadata.width ?? null,
        height: metadata.height ?? null,
        codec_name: metadata.codecName ?? null,
      };

      const thumbnailPath = join(tempDir, 'thumbnail.png');
      await this.generateThumbnail(tempFile, thumbnailPath);
      const thumbnailBytes = await readFile(thumbnailPath);
      video.thumbnail_key = `thumbnails/${video.id}/thumbnail.png`;
      await this.storageService.putObject(
        video.thumbnail_key,
        new Uint8Array(thumbnailBytes),
        'image/png',
      );

      video.status = VideoStatus.READY;
      video.error_message = null;
      await this.videoRepository.save(video);
      this.logger.log(`Video ${videoId} processed successfully`);
    } catch (err) {
      video.status = VideoStatus.ERROR;
      video.error_message =
        err instanceof Error ? err.message : 'Unknown processing error';
      await this.videoRepository.save(video);
      this.logger.error(
        `Video ${videoId} processing failed: ${video.error_message}`,
      );
      throw err;
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  private writeStreamToFile(stream: Readable, filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const write = createWriteStream(filePath);
      stream.pipe(write);
      write.on('finish', () => resolve());
      write.on('error', reject);
    });
  }

  private probeMetadata(filePath: string): Promise<{
    duration?: number;
    width?: number;
    height?: number;
    codecName?: string;
  }> {
    return new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err, data) => {
        if (err) {
          reject(err instanceof Error ? err : new Error(String(err)));
          return;
        }
        const videoStream = data.streams.find(
          (s: FfprobeStream) => s.codec_name && s.codec_name !== 'aac',
        ) as FfprobeStream | undefined;
        const durationSeconds = data.format?.duration
          ? Math.round(Number(data.format.duration))
          : undefined;
        resolve({
          duration: durationSeconds,
          width: videoStream?.width,
          height: videoStream?.height,
          codecName: videoStream?.codec_name,
        });
      });
    });
  }

  private generateThumbnail(
    inputPath: string,
    outputPath: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .on('end', () => resolve())
        .on('error', reject)
        .screenshots({
          count: 1,
          folder: outputPath.replace(/thumbnail\.png$/, ''),
          filename: 'thumbnail.png',
          size: '640x360',
        });
    });
  }
}
