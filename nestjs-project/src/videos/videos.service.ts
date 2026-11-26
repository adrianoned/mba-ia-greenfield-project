import { InjectQueue } from '@nestjs/bullmq';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import {
  VideoNotFoundException,
  VideoNotReadyException,
} from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService, StoredObject, UploadPart } from './storage.service';
import { VIDEO_PROCESS_JOB, VIDEO_PROCESSING_QUEUE } from './videos.queue';

export interface InitiateUploadInput {
  title: string;
  fileName: string;
  contentType: string;
  fileSize: number;
}

export interface InitiateUploadResult {
  videoId: string;
  uploadId: string;
  storageKey: string;
}

export interface PresignedPart {
  partNumber: number;
  url: string;
}

@Injectable()
export class VideosService {
  constructor(
    @InjectRepository(Video)
    private readonly videoRepository: Repository<Video>,
    private readonly storageService: StorageService,
    @InjectQueue(VIDEO_PROCESSING_QUEUE)
    private readonly queue: Queue,
  ) {}

  async initiateUpload(
    channelId: string,
    input: InitiateUploadInput,
  ): Promise<InitiateUploadResult> {
    const video = await this.videoRepository.save(
      this.videoRepository.create({
        channel_id: channelId,
        title: input.title,
        storage_key: `videos/{id}/original`,
      }),
    );

    const storageKey = `videos/${video.id}/original`;
    video.storage_key = storageKey;
    await this.videoRepository.save(video);

    const uploadId = await this.storageService.createMultipartUpload(
      storageKey,
      input.contentType,
    );

    return { videoId: video.id, uploadId, storageKey };
  }

  async getPresignedUploadParts(
    videoId: string,
    uploadId: string,
    partNumbers: number[],
  ): Promise<PresignedPart[]> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    return Promise.all(
      partNumbers.map(async (partNumber) => {
        const url = await this.storageService.createPresignedUploadPart(
          video.storage_key,
          uploadId,
          partNumber,
        );
        return { partNumber, url };
      }),
    );
  }

  async completeUpload(
    videoId: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<Video> {
    const video = await this.videoRepository.findOne({
      where: { id: videoId },
    });
    if (!video) {
      throw new VideoNotFoundException();
    }

    await this.storageService.completeMultipartUpload(
      video.storage_key,
      uploadId,
      parts,
    );

    await this.queue.add(VIDEO_PROCESS_JOB, { videoId: video.id });

    return video;
  }

  async findOneById(id: string): Promise<Video | null> {
    return this.videoRepository.findOne({ where: { id } });
  }

  async findByChannel(channelId: string): Promise<Video[]> {
    return this.videoRepository.find({ where: { channel_id: channelId } });
  }

  async streamVideo(id: string, range?: string): Promise<StoredObject> {
    const video = await this.videoRepository.findOne({ where: { id } });
    if (!video) {
      throw new VideoNotFoundException();
    }
    if (video.status !== VideoStatus.READY) {
      throw new VideoNotReadyException();
    }
    return this.storageService.getObject(video.storage_key, range);
  }
}
