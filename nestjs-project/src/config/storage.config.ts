import { registerAs } from '@nestjs/config';

export default registerAs('storage', () => ({
  endpoint: process.env.S3_ENDPOINT || 'http://minio:9000',
  region: process.env.S3_REGION || 'us-east-1',
  accessKey: process.env.S3_ACCESS_KEY!,
  secretKey: process.env.S3_SECRET_KEY!,
  videoBucket: process.env.S3_VIDEO_BUCKET || 'videos',
  thumbnailBucket: process.env.S3_THUMBNAIL_BUCKET || 'thumbnails',
  forcePathStyle: (process.env.S3_FORCE_PATH_STYLE ?? 'true') === 'true',
  presignedUrlExpiration: parseInt(
    process.env.PRESIGNED_URL_EXPIRATION || '3600',
    10,
  ),
}));
