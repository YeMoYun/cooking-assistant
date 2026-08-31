import {
  createBrowserRouter,
  Link,
  type RouteObject,
} from 'react-router-dom'
import { RecipeCatalogPage } from '../features/recipes/RecipeCatalogPage'
import { RecipeDetailPage } from '../features/recipes/RecipeDetailPage'
import { AppShell } from './AppShell'

const HomePage = () => (
  <div className="page page--home">
    <section className="page-heading page-heading--home">
      <h1>想吃什么，就挑一道做得好的</h1>
      <p>先看清步骤再开火；卡住时，再问小厨 AI。</p>
    </section>

    <section aria-label="开始做饭" className="home-actions">
      <Link
        aria-label="浏览食谱教程"
        className="action-card action-card--primary"
        data-visual-priority="primary"
        to="/recipes"
      >
        <span className="action-card__kicker">先挑一道菜</span>
        <strong>浏览食谱教程</strong>
        <span>从用料、火候到失败补救，一步一步看明白</span>
      </Link>
      <Link
        aria-label="和小厨 AI 通话"
        className="action-card action-card--secondary"
        data-visual-priority="secondary"
        to="/assistant"
      >
        <span className="action-card__kicker">做饭时卡住了</span>
        <strong>和小厨 AI 通话</strong>
        <span>把眼前的问题直接说出来</span>
      </Link>
    </section>

    <Link aria-label="打开购物清单" className="shopping-shortcut" to="/shopping">
      <span>
        <strong>购物清单</strong>
        <small>把缺的食材集中记下来</small>
      </span>
      <span aria-hidden="true" className="shopping-shortcut__arrow">→</span>
    </Link>
  </div>
)

const SimplePage = ({
  description,
  heading,
}: {
  readonly description: string
  readonly heading: string
}) => (
  <div className="page">
    <section className="page-heading">
      <h1>{heading}</h1>
      <p>{description}</p>
    </section>
  </div>
)

export const appRoutes: RouteObject[] = [
  {
    element: <AppShell />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'recipes', element: <RecipeCatalogPage /> },
      { path: 'recipes/:recipeId', element: <RecipeDetailPage /> },
      {
        path: 'inventory',
        element: (
          <SimplePage
            description="拍照识别与手动整理食材的入口会放在这里。"
            heading="看看冰箱里有什么"
          />
        ),
      },
      {
        path: 'shopping',
        element: (
          <SimplePage
            description="从食谱补齐缺少的食材，也可以随手添加。"
            heading="购物清单"
          />
        ),
      },
      {
        path: 'assistant',
        element: (
          <SimplePage
            description="做饭遇到具体问题时，再从这里发起实时问答。"
            heading="和小厨 AI 通话"
          />
        ),
      },
      {
        path: 'my',
        element: (
          <div className="page">
            <section className="page-heading">
              <h1>我的厨房</h1>
              <p>管理本地偏好与模型接入。</p>
            </section>
            <Link className="settings-link" to="/settings/providers">
              模型与密钥
            </Link>
          </div>
        ),
      },
      {
        path: 'settings/providers',
        element: (
          <SimplePage
            description="后续可以在这里接入 DeepSeek 等兼容模型。"
            heading="模型与密钥"
          />
        ),
      },
    ],
  },
]

export const createAppRouter = () => createBrowserRouter(appRoutes)
