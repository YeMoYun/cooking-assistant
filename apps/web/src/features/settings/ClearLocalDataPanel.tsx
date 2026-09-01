import { useState } from 'react';
import { apiClient } from '../../lib/api-client';
import { clearBrowserData } from './clear-browser-data';

const CONFIRMATION = 'CLEAR LOCAL DATA';

export const ClearLocalDataPanel = () => {
  const [confirmation, setConfirmation] = useState('');
  const [clearing, setClearing] = useState(false);
  const [error, setError] = useState<string>();

  const clear = async (): Promise<void> => {
    setClearing(true);
    setError(undefined);
    try {
      await apiClient.request('/api/privacy/clear-all', {
        method: 'POST',
        body: { confirmation },
        signal: new AbortController().signal,
      });
      await clearBrowserData();
      window.location.replace('/');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '本地数据清理失败，请重试。');
      setClearing(false);
    }
  };

  return (
    <section className="kitchen-panel">
      <h2>清空本地个人数据</h2>
      <p>保留内置食谱，删除收藏、浏览记录、库存、购物清单、笔记、改菜谱、助手会话和模型密钥。此操作无法撤销。</p>
      <label>
        输入 <code>{CONFIRMATION}</code> 确认
        <input autoComplete="off" onChange={(event) => setConfirmation(event.target.value)} value={confirmation} />
      </label>
      {error !== undefined && <p className="form-error">{error}</p>}
      <button disabled={clearing || confirmation !== CONFIRMATION} onClick={() => { void clear(); }} type="button">
        {clearing ? '正在清理…' : '永久清空本地个人数据'}
      </button>
    </section>
  );
};
