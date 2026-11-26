import { DataSource, Repository } from 'typeorm';
import { RefreshToken } from '../../auth/entities/refresh-token.entity';
import { VerificationToken } from '../../auth/entities/verification-token.entity';
import { Channel } from '../../channels/entities/channel.entity';
import {
  cleanAllTables,
  createTestDataSource,
} from '../../test/create-test-data-source';
import { User } from '../../users/entities/user.entity';
import { Video, VideoStatus } from './video.entity';

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('Video entity (integration)', () => {
  let dataSource: DataSource;
  let channelRepository: Repository<Channel>;
  let videoRepository: Repository<Video>;

  beforeAll(async () => {
    dataSource = createTestDataSource(ALL_ENTITIES);
    await dataSource.initialize();
    channelRepository = dataSource.getRepository(Channel);
    videoRepository = dataSource.getRepository(Video);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
  });

  let counter = 0;
  async function createChannel(): Promise<Channel> {
    const user = await dataSource.getRepository(User).save(
      dataSource.getRepository(User).create({
        email: `vid_user_${++counter}@example.com`,
        password: 'hashed',
      }),
    );
    return channelRepository.save(
      channelRepository.create({
        name: 'Channel',
        nickname: `vidchan_${counter}`,
        user_id: user.id,
      }),
    );
  }

  it('should default status to draft and generate a uuid id', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'My video',
        storage_key: `videos/${channel.id}/original`,
      }),
    );

    expect(video.id).toBeDefined();
    expect(video.status).toBe(VideoStatus.DRAFT);
  });

  it('should reject an invalid status value', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          title: 'Bad status',
          storage_key: 'videos/x/original',
          status: 'invalid' as VideoStatus,
        }),
      ),
    ).rejects.toThrow();
  });

  it('should enforce storage_key as required', async () => {
    const channel = await createChannel();

    await expect(
      videoRepository.save(
        videoRepository.create({
          channel_id: channel.id,
          title: 'No storage key',
        }),
      ),
    ).rejects.toThrow();
  });

  it('should allow nullable duration, metadata, thumbnail_key, and error_message', async () => {
    const channel = await createChannel();
    const video = await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Nullables',
        storage_key: 'videos/x/original',
      }),
    );

    expect(video.duration).toBeNull();
    expect(video.metadata).toBeNull();
    expect(video.thumbnail_key).toBeNull();
    expect(video.error_message).toBeNull();
  });

  it('should link the video to its channel via the many-to-one relation', async () => {
    const channel = await createChannel();
    await videoRepository.save(
      videoRepository.create({
        channel_id: channel.id,
        title: 'Linked',
        storage_key: 'videos/x/original',
      }),
    );

    const found = await videoRepository.findOne({
      where: { title: 'Linked' },
      relations: ['channel'],
    });

    expect(found?.channel.id).toBe(channel.id);
  });
});
