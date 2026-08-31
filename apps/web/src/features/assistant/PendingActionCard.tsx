import type { PendingActionPreview } from '@xiaochu/shared';
import { useState } from 'react';
import { apiClient } from '../../lib/api-client';

interface PendingActionCardProps {
  readonly action: PendingActionPreview;
  readonly onHandled: (pendingActionId: string) => void;
  readonly onError: (message: string) => void;
}

const previewText = (action: PendingActionPreview): string => {
  if (action.kind === 'note') return action.preview.body;
  if (action.kind === 'shopping_items') {
    return action.preview.items.map((item) => `${item.name} ${item.quantity}${item.unit}`).join('；');
  }
  return [...action.preview.ingredientChanges, ...action.preview.stepChanges, ...action.preview.safetyWarnings].join('；');
};

export const PendingActionCard = ({ action, onHandled, onError }: PendingActionCardProps) => {
  const [handling, setHandling] = useState(false);
  const handle = async (decision: 'confirm' | 'reject'): Promise<void> => {
    setHandling(true);
    try {
      await apiClient.request(`/api/pending-actions/${action.pendingActionId}/${decision}`, {
        method: 'POST',
        signal: new AbortController().signal,
      });
      onHandled(action.pendingActionId);
    } catch (error) {
      onError(error instanceof Error ? error.message : '操作未完成，请稍后重试。');
      setHandling(false);
    }
  };
  return (
    <aside className="assistant-action-card">
      <strong>{action.title}</strong>
      <p>{previewText(action)}</p>
      <small>此操作尚未保存，确认前可拒绝。</small>
      <div className="action-row">
        <button disabled={handling} onClick={() => { void handle('confirm'); }} type="button">确认保存</button>
        <button disabled={handling} onClick={() => { void handle('reject'); }} type="button">拒绝</button>
      </div>
    </aside>
  );
};
