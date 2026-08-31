import fastifyMultipart from '@fastify/multipart';
import {
  AppError,
  confirmRecognitionInputSchema,
  confirmRecognitionParamsSchema,
  type ApiSuccess,
  type ConfirmRecognitionResult,
  type RecognitionPreview,
} from '@xiaochu/shared';
import type {
  FastifyInstance,
  FastifyPluginAsync,
  FastifyRequest,
} from 'fastify';
import {
  ROUTE_SECURITY_CONFIGS,
} from '../../plugins/request-security.js';
import { readSessionIdFromCookieHeader } from '../../plugins/session.js';
import {
  VISION_MAX_IMAGE_BYTES,
  VisionImagePipeline,
  type PreparedVisionImage,
} from './image-pipeline.js';
import { VisionTempFileCleaner } from './temp-file-cleaner.js';
import { VisionService } from './vision-service.js';

const MULTIPART_HEADER_PAIR_LIMIT = 50;

export interface VisionRoutesOptions {
  readonly imagePipeline: VisionImagePipeline;
  readonly service: VisionService;
  readonly tempFileCleaner?: VisionTempFileCleaner;
}

const errorCode = (error: unknown): string | undefined => (
  typeof error === 'object'
  && error !== null
  && 'code' in error
  && typeof error.code === 'string'
    ? error.code
    : undefined
);

const requireSessionId = (request: FastifyRequest): string => {
  const cookie = typeof request.headers.cookie === 'string'
    ? request.headers.cookie
    : undefined;
  const sessionId = readSessionIdFromCookieHeader(cookie);
  if (sessionId === undefined) {
    throw new AppError('forbidden', 'Request forbidden', 403);
  }
  return sessionId;
};

const mapMultipartError = (error: unknown): never => {
  if (error instanceof AppError) {
    throw error;
  }
  const code = errorCode(error);
  if (
    code === 'FST_REQ_FILE_TOO_LARGE'
    || code === 'FST_ERR_CTP_BODY_TOO_LARGE'
  ) {
    throw new AppError(
      'image_too_large',
      '图片不能超过 10 MiB',
      413,
    );
  }
  if (
    code === 'FST_PARTS_LIMIT'
    || code === 'FST_FILES_LIMIT'
    || code === 'FST_FIELDS_LIMIT'
  ) {
    throw new AppError(
      'invalid_image_upload',
      '每次只能上传一个 image 文件，不能包含其他字段',
      400,
    );
  }
  if (code === 'FST_MP_PREMATURE_CLOSE') {
    throw new AppError('cancelled', '图片上传已取消', 499);
  }
  throw error;
};

export const visionRoutesPlugin: FastifyPluginAsync<VisionRoutesOptions> = async (
  app,
  options,
) => {
  await app.register(fastifyMultipart, {
    attachFieldsToBody: false,
    throwFileSizeLimit: true,
    limits: {
      fieldNameSize: 100,
      fieldSize: 0,
      fields: 0,
      fileSize: VISION_MAX_IMAGE_BYTES,
      files: 1,
      headerPairs: MULTIPART_HEADER_PAIR_LIMIT,
      parts: 1,
    },
  });

  const cleaner = options.tempFileCleaner ?? new VisionTempFileCleaner({
    directory: options.imagePipeline.tempDirectory,
    logger: app.log,
  });
  await cleaner.start();
  app.addHook('onClose', async () => cleaner.stop());

  app.post('/api/vision/recognize', {
    config: ROUTE_SECURITY_CONFIGS.visionUpload,
  }, async (request): Promise<ApiSuccess<RecognitionPreview>> => {
    if (!request.isMultipart()) {
      throw new AppError(
        'unsupported_media_type',
        '请使用 multipart/form-data 上传 image 文件',
        415,
      );
    }

    const controller = new AbortController();
    const abortRequest = (): void => controller.abort();
    request.raw.once('aborted', abortRequest);
    let prepared: PreparedVisionImage | undefined;
    try {
      const parts = request.parts({
        limits: {
          fieldNameSize: 100,
          fieldSize: 0,
          fields: 0,
          fileSize: VISION_MAX_IMAGE_BYTES,
          files: 1,
          headerPairs: MULTIPART_HEADER_PAIR_LIMIT,
          parts: 1,
        },
      });
      for await (const part of parts) {
        if (part.type !== 'file' || part.fieldname !== 'image') {
          if (part.type === 'file') {
            part.file.resume();
          }
          throw new AppError(
            'invalid_image_upload',
            '上传内容必须是唯一的 image 文件',
            400,
          );
        }
        if (prepared !== undefined) {
          part.file.resume();
          throw new AppError(
            'invalid_image_upload',
            '每次只能上传一张图片',
            400,
          );
        }
        // The client filename is deliberately ignored. Only declared MIME and
        // the file signature determine whether this image is accepted.
        prepared = await options.imagePipeline.prepare(
          part.file,
          part.mimetype,
          controller.signal,
        );
      }
      if (prepared === undefined) {
        throw new AppError(
          'image_required',
          '请选择一张要识别的图片',
          400,
        );
      }

      request.log.info({
        processedByteCount: prepared.byteLength,
        requestId: request.id,
        sourceByteCount: prepared.sourceByteLength,
      }, 'vision image prepared');
      const preview = await options.service.recognize({
        image: prepared,
        sessionId: requireSessionId(request),
        signal: controller.signal,
      });
      request.log.info({
        candidateCount: preview.candidates.length,
        requestId: request.id,
      }, 'vision candidates created');
      return { data: preview };
    } catch (error) {
      return mapMultipartError(error);
    } finally {
      request.raw.removeListener('aborted', abortRequest);
      if (prepared !== undefined) {
        await options.imagePipeline.remove(prepared).catch((error: unknown) => {
          request.log.warn({
            errorCode: 'vision_temp_cleanup_failed',
            errorName: error instanceof Error ? error.name : 'unknown',
            requestId: request.id,
          }, 'vision temp image could not be removed immediately');
        });
      }
    }
  });

  app.post('/api/vision/:recognitionId/confirm', {
    config: ROUTE_SECURITY_CONFIGS.confirmation,
  }, (request): ApiSuccess<ConfirmRecognitionResult> => {
    const params = confirmRecognitionParamsSchema.safeParse(request.params);
    const body = confirmRecognitionInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      throw new AppError(
        'validation_error',
        '确认的食材名称、数量、单位或分类无效',
        400,
      );
    }
    return {
      data: options.service.confirm({
        recognitionId: params.data.recognitionId,
        sessionId: requireSessionId(request),
        body: body.data,
      }),
    };
  });
};

export const registerVisionRoutes = (
  app: FastifyInstance,
  options: VisionRoutesOptions,
): void => {
  void app.register(visionRoutesPlugin, options);
};
