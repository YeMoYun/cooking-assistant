import {
  providerProfileListSchema,
  type ContextSelection,
  type PendingActionPreview,
  type ProviderProfile,
} from '@xiaochu/shared';
import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../lib/api-client';
import { ConversationTranscript } from './ConversationTranscript';
import { ContextPicker } from './ContextPicker';
import { PendingActionCard } from './PendingActionCard';
import { listenOnce } from './speech-recognition';
import { stopSpeaking } from './speech-synthesis';
import { TurnController, type AssistantTurnState } from './turn-controller';
import '../inventory/kitchen.css';

type Line = { readonly role: 'user' | 'assistant'; readonly text: string };
const EMPTY_CONTEXT: ContextSelection = { includeInventory: false, includeShopping: false };

export const AssistantPage = () => {
  const [providers, setProviders] = useState<ProviderProfile[]>([]);
  const [providerId, setProviderId] = useState('');
  const [sessionId, setSessionId] = useState<string>();
  const [context, setContext] = useState<ContextSelection>(EMPTY_CONTEXT);
  const [text, setText] = useState('');
  const [lines, setLines] = useState<Line[]>([]);
  const [drafts, setDrafts] = useState<PendingActionPreview[]>([]);
  const [state, setState] = useState<AssistantTurnState>('idle');
  const [muted, setMuted] = useState(false);
  const [error, setError] = useState<string>();
  const controller = useRef<TurnController | undefined>(undefined);

  useEffect(() => {
    const abort = new AbortController();
    void apiClient.request<unknown>('/api/providers', { method: 'GET', signal: abort.signal })
      .then((value) => {
        const enabled = providerProfileListSchema.parse(value)
          .filter((provider) => provider.kind === 'text' && provider.enabled);
        setProviders(enabled);
        setProviderId(enabled[0]?.id ?? '');
      })
      .catch(() => setError('无法读取模型配置。'));
    return () => abort.abort();
  }, []);

  const ensureSession = async (): Promise<string> => {
    if (sessionId !== undefined) return sessionId;
    if (providerId === '') throw new Error('请先配置一个可用的文本模型。');
    const created = await apiClient.request<{ id: string }>('/api/voice/sessions', {
      method: 'POST', body: { providerId, context }, signal: new AbortController().signal,
    });
    setSessionId(created.id);
    return created.id;
  };

  const send = async (value = text): Promise<void> => {
    const question = value.trim();
    if (question === '') return;
    try {
      const id = await ensureSession();
      setError(undefined);
      setLines((current) => [...current, { role: 'user', text: question }, { role: 'assistant', text: '' }]);
      setText('');
      const next = new TurnController(
        id,
        (delta) => setLines((current) => current.map((line, index) => (
          index === current.length - 1 && line.role === 'assistant'
            ? { ...line, text: line.text + delta } : line
        ))),
        setState,
        (action) => setDrafts((current) => [...current, action]),
        () => muted,
      );
      controller.current = next;
      await next.start(question, context);
    } catch (caught) {
      if ((caught as DOMException).name !== 'AbortError') {
        setError(caught instanceof Error ? caught.message : '智能助手暂时不可用。');
        setState('error');
      }
    }
  };

  const startListening = (): void => {
    controller.current?.cancel();
    stopSpeaking();
    listenOnce((spoken) => { setText(spoken); void send(spoken); }, setError);
  };

  const endSession = async (): Promise<void> => {
    controller.current?.cancel();
    stopSpeaking();
    if (sessionId !== undefined) {
      try {
        await apiClient.request(`/api/voice/sessions/${sessionId}/end`, {
          method: 'POST', signal: new AbortController().signal,
        });
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '会话结束失败。');
        return;
      }
    }
    setSessionId(undefined);
    setState('idle');
  };

  return (
    <section className="page kitchen-page">
      <header className="page-heading">
        <p className="eyebrow">独立智能助手</p>
        <h1>做饭卡住时，问小厨</h1>
        <p>食谱教程仍在菜谱页；这里用于解决当前的火候、调味和补救问题。</p>
      </header>
      <section className="kitchen-panel">
        <label>文本模型
          <select onChange={(event) => { setProviderId(event.target.value); setSessionId(undefined); }} value={providerId}>
            {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name} · {provider.modelId}</option>)}
          </select>
        </label>
        {providers.length === 0 && <p>没有可用文本模型。<Link to="/settings/providers">配置 DeepSeek、通义千问或自定义模型</Link>。</p>}
        <ContextPicker onChange={setContext} value={context} />
        <p className="assistant-disclosure">首次使用语音输入前请知悉：Chrome/Edge 的语音识别可能调用浏览器厂商的在线服务；本应用不会保存原始音频。</p>
        <ConversationTranscript lines={lines} />
        {drafts.map((action) => (
          <PendingActionCard
            action={action}
            key={action.pendingActionId}
            onError={setError}
            onHandled={(id) => setDrafts((current) => current.filter((item) => item.pendingActionId !== id))}
          />
        ))}
        {error !== undefined && <p className="form-error">{error}</p>}
        <textarea aria-label="烹饪问题" onChange={(event) => setText(event.target.value)} placeholder="例如：番茄炒蛋出水了，下一步怎么补救？" value={text} />
        <div className="action-row">
          <button onClick={startListening} type="button">{state === 'thinking' || state === 'speaking' ? '打断并说话' : '开始说话'}</button>
          <button onClick={() => { setMuted((value) => !value); stopSpeaking(); }} type="button">{muted ? '打开朗读' : '静音朗读'}</button>
          <button disabled={state === 'thinking' || text.trim() === ''} onClick={() => { void send(); }} type="button">{state === 'thinking' ? '思考中…' : '发送'}</button>
          <button onClick={() => { void endSession(); }} type="button">结束会话</button>
        </div>
      </section>
    </section>
  );
};
