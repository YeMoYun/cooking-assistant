import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { bindStreamCancellation } from './stream-lifecycle.js';

class FakeResponse extends EventEmitter {
  writableEnded = false;
}

describe('bindStreamCancellation', () => {
  it('ignores normal request close and cancels an unfinished closed response', () => {
    const request = new EventEmitter();
    const response = new FakeResponse();
    const controller = new AbortController();
    const cleanup = bindStreamCancellation(request, response, controller);

    request.emit('close');
    expect(controller.signal.aborted).toBe(false);
    response.emit('close');
    expect(controller.signal.aborted).toBe(true);
    cleanup();
  });

  it('cancels an aborted request but not a normally ended response', () => {
    const endedRequest = new EventEmitter();
    const endedResponse = new FakeResponse();
    endedResponse.writableEnded = true;
    const endedController = new AbortController();
    bindStreamCancellation(endedRequest, endedResponse, endedController);
    endedResponse.emit('close');
    expect(endedController.signal.aborted).toBe(false);

    const abortedRequest = new EventEmitter();
    const pendingResponse = new FakeResponse();
    const abortedController = new AbortController();
    bindStreamCancellation(abortedRequest, pendingResponse, abortedController);
    abortedRequest.emit('aborted');
    expect(abortedController.signal.aborted).toBe(true);
  });
});
