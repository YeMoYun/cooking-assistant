import type { VisionResult } from '@xiaochu/shared';
import type { PreparedVisionImage } from './image-pipeline.js';

export interface VisionRecognitionRequest {
  readonly image: PreparedVisionImage;
  readonly signal: AbortSignal;
}

export interface VisionAdapter {
  recognize(request: VisionRecognitionRequest): Promise<VisionResult>;
}
