interface StreamRequest {
  once(event: 'aborted', listener: () => void): unknown;
  off(event: 'aborted', listener: () => void): unknown;
}

interface StreamResponse {
  readonly writableEnded: boolean;
  once(event: 'close', listener: () => void): unknown;
  off(event: 'close', listener: () => void): unknown;
}

export const bindStreamCancellation = (
  request: StreamRequest,
  response: StreamResponse,
  controller: AbortController,
): (() => void) => {
  const abort = (): void => {
    if (!response.writableEnded && !controller.signal.aborted) {
      controller.abort(new Error('Client disconnected'));
    }
  };
  request.once('aborted', abort);
  response.once('close', abort);
  return () => {
    request.off('aborted', abort);
    response.off('close', abort);
  };
};
