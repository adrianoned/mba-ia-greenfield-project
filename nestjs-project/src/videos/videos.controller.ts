import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Res,
  StreamableFile,
} from '@nestjs/common';
import type { Response } from 'express';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { ChannelsService } from '../channels/channels.service';
import {
  ChannelNotFoundException,
  VideoNotFoundException,
} from '../common/exceptions/domain.exception';
import { ApiErrorEnvelope } from '../common/openapi/api-error-envelope.dto';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import type { JwtPayload } from '../auth/auth.types';
import { Public } from '../auth/decorators/public.decorator';
import { Video } from './entities/video.entity';
import { VideosService } from './videos.service';
import { CompleteUploadDto } from './dto/complete-upload.dto';
import { InitiateUploadDto } from './dto/initiate-upload.dto';
import { UploadPartsDto } from './dto/upload-parts.dto';

@ApiTags('videos')
@Controller('videos')
export class VideosController {
  constructor(
    private readonly videosService: VideosService,
    private readonly channelsService: ChannelsService,
  ) {}

  @Post('uploads')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Initiate a video upload',
    description:
      'Pre-registers a video as draft under the authenticated user channel and starts a multipart upload in storage, returning the presigned upload id and storage key.',
  })
  @ApiResponse({
    status: 201,
    description: 'Upload initiated',
    schema: {
      properties: {
        videoId: { type: 'string', format: 'uuid' },
        uploadId: { type: 'string' },
        storageKey: { type: 'string' },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 400,
    description: 'Validation failed',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async initiateUpload(
    @CurrentUser() user: JwtPayload,
    @Body() dto: InitiateUploadDto,
  ): Promise<{ videoId: string; uploadId: string; storageKey: string }> {
    const channel = await this.channelsService.findByUserId(user.sub);
    const channelId = channel?.id;
    if (!channelId) {
      throw new ChannelNotFoundException();
    }
    return this.videosService.initiateUpload(channelId, dto);
  }

  @Post('uploads/:videoId/parts')
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Get presigned URLs for upload parts',
    description:
      'Returns presigned UploadPart URLs for the given part numbers of a multipart upload.',
  })
  @ApiResponse({
    status: 200,
    description: 'Presigned part URLs',
    schema: {
      properties: {
        parts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              partNumber: { type: 'number' },
              url: { type: 'string' },
            },
          },
        },
      },
    },
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getUploadParts(
    @Param('videoId') videoId: string,
    @Body() dto: UploadPartsDto,
  ): Promise<{ parts: { partNumber: number; url: string }[] }> {
    const parts = await this.videosService.getPresignedUploadParts(
      videoId,
      dto.uploadId,
      dto.partNumbers,
    );
    return { parts };
  }

  @Post('uploads/:videoId/complete')
  @HttpCode(HttpStatus.OK)
  @ApiBearerAuth('access-token')
  @ApiOperation({
    summary: 'Complete a video upload',
    description:
      'Finalizes the multipart upload and enqueues the video for background processing.',
  })
  @ApiResponse({
    status: 200,
    description: 'Upload completed and processing enqueued',
    type: Video,
  })
  @ApiResponse({
    status: 401,
    description: 'Missing or invalid access token',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async completeUpload(
    @Param('videoId') videoId: string,
    @Body() dto: CompleteUploadDto,
  ): Promise<Video> {
    return this.videosService.completeUpload(
      videoId,
      dto.uploadId,
      dto.parts.map((p) => ({ partNumber: p.partNumber, etag: p.etag })),
    );
  }

  @Public()
  @Get(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Get video metadata',
    description:
      'Returns the public metadata of a video (status, duration, thumbnail).',
  })
  @ApiResponse({ status: 200, description: 'Video metadata', type: Video })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async getVideo(@Param('id') id: string): Promise<Video> {
    const video = await this.videosService.findOneById(id);
    if (!video) {
      throw new VideoNotFoundException();
    }
    return video;
  }

  @Public()
  @Get(':id/stream')
  @Header('Accept-Ranges', 'bytes')
  @ApiOperation({
    summary: 'Stream or download a video',
    description:
      'Streams the video honoring HTTP Range requests (206 Partial Content) or returns the full object for download.',
  })
  @ApiResponse({
    status: 206,
    description: 'Partial content (streaming)',
  })
  @ApiResponse({ status: 200, description: 'Full object (download)' })
  @ApiResponse({
    status: 404,
    description: 'Video not found',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  @ApiResponse({
    status: 409,
    description: 'Video not ready',
    schema: { $ref: getSchemaPath(ApiErrorEnvelope) },
  })
  async streamVideo(
    @Param('id') id: string,
    @Headers('range') range: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile> {
    const stored = await this.videosService.streamVideo(id, range);

    if (stored.contentType) {
      res.setHeader('Content-Type', stored.contentType);
    }
    if (stored.contentRange) {
      res.status(HttpStatus.PARTIAL_CONTENT);
      res.setHeader('Content-Range', stored.contentRange);
      res.setHeader('Content-Length', String(stored.contentLength ?? 0));
    } else if (stored.contentLength !== undefined) {
      res.setHeader('Content-Length', String(stored.contentLength));
    }

    return new StreamableFile(stored.body);
  }
}
