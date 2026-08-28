import {
  createBrowserRouter,
  Link,
  type RouteObject,
  useParams,
} from 'react-router-dom'
import { AppShell } from './AppShell'

const recipePreviews = [
  { id: 'tomato-eggs', name: '番茄炒蛋', note: '酸甜下饭 · 约 15 分钟' },
  { id: 'scallion-noodles', name: '葱油拌面', note: '香而不腻 · 约 20 分钟' },
  { id: 'steamed-egg', name: '家常蒸蛋', note: '嫩滑不蜂窝 · 约 18 分钟' },
  { id: 'pepper-potato', name: '青椒土豆丝', note: '清脆入味 · 约 20 分钟' },
] as const

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

const RecipesPage = () => (
  <div className="page">
    <section className="page-heading">
      <h1>找一道今天能做好的菜</h1>
      <p>这里先展示简要信息，点开后再看完整教程。</p>
    </section>

    <section aria-label="食谱列表" className="recipe-grid">
      {recipePreviews.map((recipe) => (
        <Link className="recipe-card" key={recipe.id} to={`/recipes/${recipe.id}`}>
          <span
            aria-label={`${recipe.name}图片占位`}
            className="recipe-card__media"
            data-media-ratio="4:3"
            role="img"
          >
            <span aria-hidden="true" className="recipe-card__media-mark" />
          </span>
          <span className="recipe-card__body">
            <strong>{recipe.name}</strong>
            <small>{recipe.note}</small>
          </span>
        </Link>
      ))}
    </section>
  </div>
)

const RecipeDetailPage = () => {
  const { recipeId } = useParams()
  const recipe = recipePreviews.find(({ id }) => id === recipeId)

  return (
    <div className="page">
      <section className="page-heading">
        <h1>食谱教程</h1>
        <p>{recipe?.name ?? '这道菜'}的超详细文字步骤与视频将在食谱内容接入后显示。</p>
      </section>
      <div aria-label="教程内容占位" className="content-placeholder">
        <span />
        <span />
        <span />
      </div>
    </div>
  )
}

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
      { path: 'recipes', element: <RecipesPage /> },
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
