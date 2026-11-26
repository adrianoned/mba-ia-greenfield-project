import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateBucketCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Readable } from 'node:stream';
import storageConfig from '../config/storage.config';

export interface StoredObject {
  body: Readable;
  contentLength: number | undefined;
  contentType: string | undefined;
  contentRange: string | undefined;
}

export interface UploadPart {
  partNumber: number;
  etag: string;
}

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly client: S3Client;

  constructor(
    @Inject(storageConfig.KEY)
    private readonly config: ConfigType<typeof storageConfig>,
  ) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: {
        accessKeyId: config.accessKey,
        secretAccessKey: config.secretKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureBuckets();
  }

  async ensureBuckets(): Promise<void> {
    const buckets = [
      this.config.videoBucket,
      this.config.thumbnailBucket,
    ].filter((name): name is string => Boolean(name));

    for (const bucket of new Set(buckets)) {
      const exists = await this.bucketExists(bucket);
      if (!exists) {
        await this.client.send(new CreateBucketCommand({ Bucket: bucket }));
      }
    }
  }

  private async bucketExists(bucket: string): Promise<boolean> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: bucket }));
      return true;
    } catch {
      return false;
    }
  }

  async createPresignedPut(key: string, contentType: string): Promise<string> {
    return getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.config.videoBucket,
        Key: key,
        ContentType: contentType,
      }),
      { expiresIn: this.config.presignedUrlExpiration },
    );
  }

  async createMultipartUpload(
    key: string,
    contentType: string,
  ): Promise<string> {
    const command = new CreateMultipartUploadCommand({
      Bucket: this.config.videoBucket,
      Key: key,
      ContentType: contentType,
    });
    const result = await this.client.send(command);
    if (!result.UploadId) {
      throw new Error('Storage did not return an UploadId');
    }
    return result.UploadId;
  }

  async createPresignedUploadPart(
    key: string,
    uploadId: string,
    partNumber: number,
  ): Promise<string> {
    return getSignedUrl(
      this.client,
      new UploadPartCommand({
        Bucket: this.config.videoBucket,
        Key: key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: this.config.presignedUrlExpiration },
    );
  }

  async completeMultipartUpload(
    key: string,
    uploadId: string,
    parts: UploadPart[],
  ): Promise<void> {
    await this.client.send(
      new CompleteMultipartUploadCommand({
        Bucket: this.config.videoBucket,
        Key: key,
        UploadId: uploadId,
        MultipartUpload: {
          Parts: parts.map((p) => ({
            PartNumber: p.partNumber,
            ETag: p.etag,
          })),
        },
      }),
    );
  }

  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    await this.client.send(
      new AbortMultipartUploadCommand({
        Bucket: this.config.videoBucket,
        Key: key,
        UploadId: uploadId,
      }),
    );
  }

  async putObject(
    key: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.config.thumbnailBucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  async getObject(key: string, range?: string): Promise<StoredObject> {
    const command = new GetObjectCommand({
      Bucket: this.config.videoBucket,
      Key: key,
      ...(range ? { Range: range } : {}),
    });
    const result = await this.client.send(command);
    return {
      body: result.Body as Readable,
      contentLength: result.ContentLength,
      contentType: result.ContentType,
      contentRange: result.ContentRange,
    };
  }

  async objectExists(key: string): Promise<boolean> {
    try {
      await this.client.send(
        new HeadObjectCommand({
          Bucket: this.config.videoBucket,
          Key: key,
        }),
      );
      return true;
    } catch {
      return false;
    }
  }
}
