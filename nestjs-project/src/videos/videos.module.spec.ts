import { Test } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { VerificationToken } from '../auth/entities/verification-token.entity';
import { Channel } from '../channels/entities/channel.entity';
import { ChannelsModule } from '../channels/channels.module';
import { User } from '../users/entities/user.entity';
import { createTestDataSource } from '../test/create-test-data-source';
import queueConfig from '../config/queue.config';
import storageConfig from '../config/storage.config';
import { Video } from './entities/video.entity';
import { VideosModule } from './videos.module';

jest.mock('@nestjs/bullmq', () => {
  const { Inject } = jest.requireActual('@nestjs/common');
  const getQueueToken = (name: string) => `BullQueue_${name}`;
  return {
    BullModule: {
      forRootAsync: jest.fn().mockReturnValue({ module: class {} }),
      registerQueue: jest
        .fn()
        .mockImplementation(({ name }: { name: string }) => ({
          module: class {},
          providers: [
            { provide: getQueueToken(name), useValue: { add: jest.fn() } },
          ],
          exports: [getQueueToken(name)],
        })),
    },
    getQueueToken,
    Processor: () => (cls: unknown) => cls,
    WorkerHost: class {},
    InjectQueue: (name: string) => Inject(getQueueToken(name)),
  };
});

const ALL_ENTITIES = [User, Channel, Video, RefreshToken, VerificationToken];

describe('VideosModule', () => {
  it('should compile with TypeOrmModule.forFeature([Video]) and ChannelsModule', async () => {
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          load: [storageConfig, queueConfig],
        }),
        TypeOrmModule.forRoot(createTestDataSource(ALL_ENTITIES).options),
        ChannelsModule,
        VideosModule,
      ],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  }, 30000);
});
