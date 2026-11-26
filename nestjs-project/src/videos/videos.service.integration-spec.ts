import { DataSource, Repository } from 'typeorm';
import { Queue } from 'bullmq';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { User } from '../users/entities/user.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../test/create-test-data-source';
import { Video, VideoStatus } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideosService } from './videos.service';
import { VIDEO_PROCESS_JOB } from './videos.queue';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosService (integration)', () => {
  let dataSource: DataSource;
  let videoRepository: Repository<Video>;
  let service: VideosService;
  let storageService: jest.Mocked<
    Pick<StorageService, 'createMultipartUpload' | 'completeMultipartUpload'>
  >;
  let queue: jest.Mocked<Pick<Queue, 'add'>>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    storageService = {
      createMultipartUpload: jest.fn().mockResolvedValue('upload-123'),
      completeMultipartUpload: jest.fn().mockResolvedValue(undefined),
    };
    queue = { add: jest.fn().mockResolvedValue({} as never) };
    service = new VideosService(
      videoRepository,
      storageService as unknown as StorageService,
      queue as unknown as Queue,
    );
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `vidsvc_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return dataSource.getRepository(Channel).save(
      dataSource.getRepository(Channel).create({
        name: 'Channel',
        nickname: `vidsvc_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should persist a draft video with the correct channel FK and storage key', async () => {
    const channel = await createChannel();

    const result = await service.initiateUpload(channel.id, {
      title: 'My video',
      fileName: 'video.mp4',
      contentType: 'video/mp4',
      fileSize: 1024,
    });

    const persisted = await videoRepository.findOne({
      where: { id: result.videoId },
    });

    expect(persisted).toBeDefined();
    expect(persisted?.channel_id).toBe(channel.id);
    expect(persisted?.status).toBe(VideoStatus.DRAFT);
    expect(persisted?.storage_key).toBe(`videos/${result.videoId}/original`);
  });

  it('should complete the upload and enqueue a process job', async () => {
    const channel = await createChannel();
    const { videoId, uploadId } = await service.initiateUpload(channel.id, {
      title: 'Video',
      fileName: 'v.mp4',
      contentType: 'video/mp4',
      fileSize: 512,
    });

    await service.completeUpload(videoId, uploadId, [
      { partNumber: 1, etag: '"etag-1"' },
    ]);

    expect(storageService.completeMultipartUpload).toHaveBeenCalledWith(
      `videos/${videoId}/original`,
      uploadId,
      [{ partNumber: 1, etag: '"etag-1"' }],
    );
    expect(queue.add).toHaveBeenCalledWith(VIDEO_PROCESS_JOB, { videoId });
  });
});
