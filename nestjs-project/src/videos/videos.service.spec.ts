import { Queue } from 'bullmq';
import { Repository } from 'typeorm';
import { VideoNotFoundException } from '../common/exceptions/domain.exception';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';
import { VIDEO_PROCESS_JOB } from './videos.queue';

describe('VideosService', () => {
  let service: VideosService;
  let videoRepository: jest.Mocked<
    Pick<Repository<Video>, 'findOne' | 'save' | 'create' | 'find'>
  >;
  let storageService: jest.Mocked<
    Pick<
      StorageService,
      | 'createMultipartUpload'
      | 'createPresignedUploadPart'
      | 'completeMultipartUpload'
    >
  >;
  let queue: jest.Mocked<Pick<Queue, 'add'>>;

  const video = {
    id: 'video-1',
    channel_id: 'channel-1',
    title: 'Test',
    status: VideoStatus.DRAFT,
    storage_key: 'videos/video-1/original',
    thumbnail_key: null,
    duration: null,
    metadata: null,
    error_message: null,
  } as Video;

  beforeEach(() => {
    jest.clearAllMocks();
    videoRepository = {
      findOne: jest.fn().mockResolvedValue({ ...video }),
      save: jest
        .fn()
        .mockImplementation((v: Video) => Promise.resolve({ ...v })),
      create: jest.fn().mockImplementation((v: Partial<Video>) => v as Video),
      find: jest.fn().mockResolvedValue([]),
    };
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
      createPresignedUploadPart: jest
        .fn()
        .mockResolvedValue('https://signed/part'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue({} as never) };

    service = new VideosService(
      videoRepository as unknown as Repository<Video>,
      storageService as unknown as StorageService,
      queue as unknown as Queue,
    );
  });

  it('should initiate upload creating a draft video and a multipart upload', async () => {
    videoRepository.save
      .mockResolvedValueOnce({ ...video, id: 'video-1' })
      .mockResolvedValueOnce({ ...video, id: 'video-1' });

    const result = await service.initiateUpload('channel-1', {
      title: 'Test',
      fileName: 'test.mp4',
      contentType: 'video/mp4',
      fileSize: 1024,
    });

    expect(result.videoId).toBe('video-1');
    expect(result.uploadId).toBe('upload-123');
    expect(result.storageKey).toBe('videos/video-1/original');
    expect(storageService.createMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original',
      'video/mp4',
    );
  });

  it('should return presigned part URLs', async () => {
    const parts = await service.getPresignedUploadParts(
      'video-1',
      'upload-123',
      [1, 2],
    );

    expect(parts).toEqual([
      { partNumber: 1, url: 'https://signed/part' },
      { partNumber: 2, url: 'https://signed/part' },
    ]);
    expect(storageService.createPresignedUploadPart).toHaveBeenCalledWith(
      'videos/video-1/original',
      'upload-123',
      1,
    );
  });

  it('should complete the multipart upload and enqueue a process job', async () => {
    await service.completeUpload('video-1', 'upload-123', [
      { partNumber: 1, etag: '"etag-1"' },
    ]);

    expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
      'videos/video-1/original',
      'upload-123',
      [{ partNumber: 1, etag: '"etag-1"' }],
    );
    expect(queue.add).toHaveBeenCalledWith(VIDEO_PROCESS_JOB, {
      videoId: 'video-1',
    });
  });

  it('should throw VideoNotFoundException for unknown video on parts', async () => {
    videoRepository.findOne.mockResolvedValueOnce(null);

    await expect(
      service.getPresignedUploadParts('missing', 'upload', [1]),
    ).rejects.toThrow(VideoNotFoundException);
  });

  it('should find a video by id', async () => {
    await service.findOneById('video-1');

    expect(videoRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'video-1' },
    });
  });
});
