import type { ConfigType } from '@nestjs/config';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  CompleteMultipartUploadCommand,
  GetObjectCommand,
  PutObjectCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import type storageConfig from '../config/storage.config';
import { StorageService } from './storage.service';

jest.mock('@aws-sdk/client-s3', () => {
  const send = jest.fn();
  class MockClient {
    send = send;
  }
  return {
    S3Client: MockClient,
    CreateBucketCommand: jest.fn(),
    CreateMultipartUploadCommand: jest.fn(),
    CompleteMultipartUploadCommand: jest.fn(),
    AbortMultipartUploadCommand: jest.fn(),
    GetObjectCommand: jest.fn(),
    HeadBucketCommand: jest.fn(),
    HeadObjectCommand: jest.fn(),
    PutObjectCommand: jest.fn(),
    UploadPartCommand: jest.fn(),
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const mockGetSignedUrl = getSignedUrl as jest.Mock;
const mockSend = jest.fn();

describe('StorageService', () => {
  let service: StorageService;

  const config = {
    region: 'us-east-1',
    endpoint: 'http://minio:9000',
    accessKey: 'access',
    secretKey: 'secret',
    videoBucket: 'videos',
    thumbnailBucket: 'thumbnails',
    forcePathStyle: true,
    presignedUrlExpiration: 3600,
  } as unknown as ConfigType<typeof storageConfig>;

  beforeEach(() => {
    jest.clearAllMocks();
    service = new StorageService(config);
    // replace the internal client's send with the mock
    (service as unknown as { client: { send: jest.Mock } }).client.send =
      mockSend;
  });

  it('should presign a PutObject command for direct upload', async () => {
    mockGetSignedUrl.mockResolvedValueOnce('https://signed/put');

    const url = await service.createPresignedPut(
      'videos/x/original',
      'video/mp4',
    );

    expect(url).toBe('https://signed/put');
    expect(mockGetSignedUrl).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { expiresIn: 3600 },
    );
    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'videos',
        Key: 'videos/x/original',
        ContentType: 'video/mp4',
      }),
    );
  });

  it('should create a multipart upload and return the UploadId', async () => {
    mockSend.mockResolvedValueOnce({ UploadId: 'upload-123' });

    const uploadId = await service.createMultipartUpload(
      'videos/x/original',
      'video/mp4',
    );

    expect(uploadId).toBe('upload-123');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('should presign an UploadPart command scoped to uploadId + partNumber', async () => {
    mockGetSignedUrl.mockResolvedValueOnce('https://signed/part');

    const url = await service.createPresignedUploadPart(
      'videos/x/original',
      'upload-123',
      1,
    );

    expect(url).toBe('https://signed/part');
    expect(UploadPartCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        UploadId: 'upload-123',
        PartNumber: 1,
      }),
    );
  });

  it('should complete a multipart upload with the ETags', async () => {
    mockSend.mockResolvedValueOnce({});

    await service.completeMultipartUpload('videos/x/original', 'upload-123', [
      { partNumber: 1, etag: '"etag-1"' },
      { partNumber: 2, etag: '"etag-2"' },
    ]);

    expect(CompleteMultipartUploadCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        UploadId: 'upload-123',
        MultipartUpload: {
          Parts: [
            { PartNumber: 1, ETag: '"etag-1"' },
            { PartNumber: 2, ETag: '"etag-2"' },
          ],
        },
      }),
    );
  });

  it('should return a StoredObject stream from getObject with a Range', async () => {
    mockSend.mockResolvedValueOnce({
      Body: { pipe: () => undefined } as unknown as NodeJS.ReadableStream,
      ContentLength: 100,
      ContentType: 'video/mp4',
      ContentRange: 'bytes 0-99/1000',
    });

    const obj = await service.getObject('videos/x/original', 'bytes=0-99');

    expect(obj.contentLength).toBe(100);
    expect(obj.contentRange).toBe('bytes 0-99/1000');
    expect(GetObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({ Range: 'bytes=0-99' }),
    );
  });

  it('should return false when HeadObject throws (object absent)', async () => {
    mockSend.mockRejectedValueOnce(new Error('NotFound'));

    await expect(service.objectExists('videos/missing')).resolves.toBe(false);
  });

  it('should return true when HeadObject succeeds', async () => {
    mockSend.mockResolvedValueOnce({});

    await expect(service.objectExists('videos/x/original')).resolves.toBe(true);
  });

  it('should upload a thumbnail via PutObject to the thumbnail bucket', async () => {
    mockSend.mockResolvedValueOnce({});

    await service.putObject(
      'thumbnails/x/t.png',
      new Uint8Array([1]),
      'image/png',
    );

    expect(PutObjectCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        Bucket: 'thumbnails',
        Key: 'thumbnails/x/t.png',
        ContentType: 'image/png',
      }),
    );
  });
});
