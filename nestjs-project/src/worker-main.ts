import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  // createApplicationContext boots the DI container without opening an HTTP
  // server. The VideoProcessingProcessor (registered via @Processor in
  // VideosModule) starts consuming the 'video-processing' queue immediately.
  await NestFactory.createApplicationContext(AppModule);
}

void bootstrap();
