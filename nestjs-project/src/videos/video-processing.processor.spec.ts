import { Job } from 'bullmq';
import { Repository } from 'typeorm';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideoProcessingProcessor } from './video-processing.processor';

jest.mock('fluent-ffmpeg', () => {
  const ffmpegFn = jest.fn(() => ({
    on: jest.fn().mockReturnThis(),
    screenshots: jest.fn(),
  }));
  (ffmpegFn as unknown as { ffprobe: jest.Mock }).ffprobe = jest.fn();
  return ffmpegFn;
});

jest.mock('node:fs/promises', () => ({
  mkdtemp: jest.fn().mockResolvedValue('/tmp/streamtube-test'),
  readFile: jest.fn().mockResolvedValue(Buffer.from('png-bytes')),
  rm: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('node:fs', () => {
  const actualFs = jest.requireActual('node:fs');
  const writeStream = {
    on: jest.fn().mockImplementation(function (
      this: { on: jest.Mock },
      event: string,
      cb: () => void,
    ) {
      if (event === 'finish') cb();
      return this;
    }),
  };
  return {
    ...actualFs,
    createWriteStream: jest.fn(() => writeStream),
  };
});

import ffmpeg from 'fluent-ffmpeg';

const ffmpegMock = ffmpeg as unknown as jest.Mock & {
  ffprobe: jest.Mock;
};

describe('VideoProcessingProcessor', () => {
  let processor: VideoProcessingProcessor;
  let videoRepository: jest.Mocked<Pick<Repository<Video>, 'findOne' | 'save'>>;
  let storageService: jest.Mocked<
    Pick<StorageService, 'getObject' | 'putObject'>
  >;
  let savedStatuses: VideoStatus[];

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
    savedStatuses = [];
    videoRepository = {
      findOne: jest.fn().mockResolvedValue({ ...video }),
      save: jest.fn().mockImplementation((v: Video) => {
        savedStatuses.push(v.status);
        return Promise.resolve({ ...v });
      }),
    };
    storageService = {
      getObject: jest.fn().mockResolvedValue({
        body: {
          pipe: (w: { on: (e: string, cb: () => void) => void }) =>
            w.on('finish', () => undefined),
        } as unknown as NodeJS.ReadableStream,
        contentLength: 100,
        contentType: 'video/mp4',
        contentRange: undefined,
      }),
      putObject: jest.fn().mockResolvedValue(undefined),
    };

    processor = new VideoProcessingProcessor(
      videoRepository as unknown as Repository<Video>,
      storageService as unknown as StorageService,
    );
  });

  it('should set processing, extract metadata, generate thumbnail, and set ready', async () => {
    ffmpegMock.ffprobe.mockImplementationOnce(
      (_path: string, cb: (err: null, data: unknown) => void) =>
        cb(null, {
          format: { duration: '65.7' },
          streams: [
            { codec_name: 'h264', width: 1920, height: 1080 },
            { codec_name: 'aac' },
          ],
        }),
    );

    const chain = {
      on: jest.fn().mockImplementation(function (
        this: { on: jest.Mock; screenshots: jest.Mock },
        event: string,
        cb: () => void,
      ) {
        if (event === 'end') cb();
        return this;
      }),
      screenshots: jest.fn(),
    };
    ffmpegMock.mockReturnValueOnce(chain);

    const job = { data: { videoId: 'video-1' } } as Job<{ videoId: string }>;

    await processor.process(job);

    expect(videoRepository.findOne).toHaveBeenCalledWith({
      where: { id: 'video-1' },
    });
    expect(storageService.getObject).toHaveBeenCalledWith(
      'videos/video-1/original',
    );
    expect(savedStatuses).toContain(VideoStatus.PROCESSING);
    expect(savedStatuses).toContain(VideoStatus.READY);
  });

  it('should set error status and rethrow on processing failure', async () => {
    storageService.getObject.mockRejectedValueOnce(
      new Error('download failed'),
    );

    const job = { data: { videoId: 'video-1' } } as Job<{ videoId: string }>;

    await expect(processor.process(job)).rejects.toThrow('download failed');

    expect(savedStatuses).toContain(VideoStatus.ERROR);
  });

  it('should skip stale jobs when the video is not found', async () => {
    videoRepository.findOne.mockResolvedValueOnce(null);

    const job = { data: { videoId: 'missing' } } as Job<{ videoId: string }>;

    await processor.process(job);

    expect(videoRepository.save).not.toHaveBeenCalled();
  });
});
