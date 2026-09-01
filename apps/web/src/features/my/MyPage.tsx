import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { apiClient } from '../../lib/api-client';
import { ClearLocalDataPanel } from '../settings/ClearLocalDataPanel';

interface RecipeCard { readonly id: string; readonly title: string; readonly summary: string; }
interface Collection { readonly items: readonly RecipeCard[]; }
interface Variant { readonly id: string; readonly name: string; readonly sourceRecipeTitle: string; }
interface VariantPage { readonly items: readonly Variant[]; }
interface VoiceSession { readonly id: string; readonly providerName: string; readonly startedAt: string; readonly status: string; }

const Empty = ({ children }: { readonly children: string }) => <p className="empty-state">{children}</p>;

export const MyPage = () => {
  const [favorites, setFavorites] = useState<Collection>();
  const [recent, setRecent] = useState<Collection>();
  const [variants, setVariants] = useState<VariantPage>();
  const [sessions, setSessions] = useState<readonly VoiceSession[]>();
  const [errors, setErrors] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const abort = new AbortController();
    const load = async <T,>(key: string, path: string, set: (value: T) => void): Promise<void> => {
      try { set(await apiClient.request<T>(path, { method: 'GET', signal: abort.signal })); }
      catch { if (!abort.signal.aborted) setErrors((current) => ({ ...current, [key]: true })); }
    };
    void load('favorites', '/api/favorites?limit=10', setFavorites);
    void load('recent', '/api/recent-views?limit=10', setRecent);
    void load('variants', '/api/recipe-variants?limit=10', setVariants);
    void load('sessions', '/api/voice/sessions', setSessions);
    return () => abort.abort();
  }, []);

  return (
    <section className="page kitchen-page">
      <header className="page-heading"><p className="eyebrow">我的厨房</p><h1>本地收藏与记录</h1><p>这些内容保存在当前电脑的本地应用数据中。</p></header>
      <section className="kitchen-panel"><h2>收藏菜谱</h2>
        {errors.favorites ? <Empty>暂时无法读取收藏。</Empty> : favorites?.items.length === 0 ? <Empty>还没有收藏菜谱。</Empty> : favorites?.items.map((item) => <Link className="settings-link" key={item.id} to={`/recipes/${item.id}`}>{item.title}</Link>)}
      </section>
      <section className="kitchen-panel"><h2>最近浏览</h2>
        {errors.recent ? <Empty>暂时无法读取最近浏览。</Empty> : recent?.items.length === 0 ? <Empty>打开菜谱后会显示在这里。</Empty> : recent?.items.map((item) => <Link className="settings-link" key={item.id} to={`/recipes/${item.id}`}>{item.title}</Link>)}
      </section>
      <section className="kitchen-panel"><h2>AI 改菜谱</h2>
        {errors.variants ? <Empty>暂时无法读取改菜谱记录。</Empty> : variants?.items.length === 0 ? <Empty>还没有已确认的改菜谱。</Empty> : variants?.items.map((item) => <p key={item.id}>{item.name}（来自 {item.sourceRecipeTitle}）</p>)}
      </section>
      <section className="kitchen-panel"><h2>助手会话</h2>
        {errors.sessions ? <Empty>暂时无法读取会话记录。</Empty> : sessions?.length === 0 ? <Empty>还没有助手会话。</Empty> : sessions?.map((item) => <p key={item.id}>{item.providerName} · {new Date(item.startedAt).toLocaleString()} · {item.status}</p>)}
      </section>
      <section className="kitchen-panel"><h2>模型与本地数据</h2><Link className="settings-link" to="/settings/providers">管理模型密钥与连接</Link></section>
      <ClearLocalDataPanel />
    </section>
  );
};
