import { Module } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ChannelsModule } from '../channels/channels.module';
import queueConfig from '../config/queue.config';
import { Video } from './entities/video.entity';
import { StorageService } from './storage.service';
import { VideoProcessingProcessor } from './video-processing.processor';
import { VideosController } from './videos.controller';
import { VideosService } from './videos.service';
import { VIDEO_PROCESSING_QUEUE } from './videos.queue';

@Module({
  imports: [
    TypeOrmModule.forFeature([Video]),
    ChannelsModule,
    BullModule.forRootAsync({
      inject: [queueConfig.KEY],
      useFactory: (cfg: ConfigType<typeof queueConfig>) => ({
        connection: {
          host: cfg.redisHost,
          port: cfg.redisPort,
        },
      }),
    }),
    BullModule.registerQueue({ name: VIDEO_PROCESSING_QUEUE }),
  ],
  controllers: [VideosController],
  providers: [StorageService, VideoProcessingProcessor, VideosService],
  exports: [TypeOrmModule, StorageService, VideosService],
})
export class VideosModule {}
