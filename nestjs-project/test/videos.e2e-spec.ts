import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { DataSource } from 'typeorm';
import { ThrottlerStorage, ThrottlerStorageService } from '@nestjs/throttler';
import { AppModule } from '../src/app.module';
import { AuthService } from '../src/auth/auth.service';
import { DomainExceptionFilter } from '../src/common/filters/domain-exception.filter';
import { ValidationExceptionFilter } from '../src/common/filters/validation-exception.filter';
import { cleanAllTables } from '../src/test/create-test-data-source';

describe('Videos (e2e)', () => {
  let app: INestApplication<App>;
  let dataSource: DataSource;
  let throttlerStorage: ThrottlerStorageService;

  beforeAll(async () => {
    const moduleFixture = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    app.useGlobalFilters(
      new DomainExceptionFilter(),
      new ValidationExceptionFilter(),
    );
    await app.init();

    dataSource = moduleFixture.get(DataSource);
    throttlerStorage =
      moduleFixture.get<ThrottlerStorageService>(ThrottlerStorage);
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(async () => {
    await cleanAllTables(dataSource);
    throttlerStorage.storage.clear();
  });

  async function registerConfirmAndLogin(
    email: string,
  ): Promise<{ access_token: string }> {
    const authService = app.get(AuthService);
    const mailServiceInstance = (authService as any).mailService;
    let capturedToken = '';
    jest
      .spyOn(mailServiceInstance, 'sendConfirmationEmail')
      .mockImplementationOnce(async (_e: string, _n: string, t: string) => {
        capturedToken = t;
      });
    await request(app.getHttpServer())
      .post('/auth/register')
      .send({ email, password: 'password123' });
    await request(app.getHttpServer())
      .get('/auth/confirm-email')
      .query({ token: capturedToken });
    const login = await request(app.getHttpServer())
      .post('/auth/login')
      .send({ email, password: 'password123' });
    return { access_token: login.body.access_token };
  }

  describe('POST /videos/uploads', () => {
    it('returns 201 with a draft video for an authenticated user', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'uploader@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${access_token}`)
        .send({
          title: 'My video',
          fileName: 'video.mp4',
          contentType: 'video/mp4',
          fileSize: 1024,
        })
        .expect(201);

      expect(res.body.videoId).toBeDefined();
      expect(res.body.uploadId).toBeDefined();
      expect(res.body.storageKey).toContain(res.body.videoId);
    });

    it('returns 401 without an access token', async () => {
      await request(app.getHttpServer())
        .post('/videos/uploads')
        .send({
          title: 'My video',
          fileName: 'video.mp4',
          contentType: 'video/mp4',
          fileSize: 1024,
        })
        .expect(401);
    });

    it('returns 400 with VALIDATION_ERROR on missing fields', async () => {
      const { access_token } = await registerConfirmAndLogin(
        'invalid@example.com',
      );

      const res = await request(app.getHttpServer())
        .post('/videos/uploads')
        .set('Authorization', `Bearer ${access_token}`)
        .send({ title: 'My video' })
        .expect(400);

      expect(res.body.error).toBe('VALIDATION_ERROR');
    });
  });

  describe('GET /videos/:id', () => {
    it('returns 404 with VIDEO_NOT_FOUND for an unknown id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });

  describe('GET /videos/:id/stream', () => {
    it('returns 404 with VIDEO_NOT_FOUND for an unknown id', async () => {
      const res = await request(app.getHttpServer())
        .get('/videos/00000000-0000-0000-0000-000000000000/stream')
        .expect(404);

      expect(res.body.error).toBe('VIDEO_NOT_FOUND');
    });
  });
});
