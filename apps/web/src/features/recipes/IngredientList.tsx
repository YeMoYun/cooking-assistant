import type { RecipeDetail } from '@xiaochu/shared'

export type IngredientListProps = Readonly<{
  ingredients: RecipeDetail['ingredients']
  servings: number
}>

const quantityFormatter = new Intl.NumberFormat('zh-CN', {
  maximumFractionDigits: 2,
})

export const IngredientList = ({
  ingredients,
  servings,
}: IngredientListProps) => (
  <section aria-labelledby="recipe-ingredients-title" className="detail-section">
    <header className="detail-section__heading">
      <div>
        <h2 id="recipe-ingredients-title">备料清单</h2>
        <p>{quantityFormatter.format(servings)} 人份，用量以导入食谱为准。</p>
      </div>
      <span>{ingredients.length} 项</span>
    </header>

    <ul className="ingredient-list">
      {ingredients.map((ingredient) => (
        <li className="ingredient-row" key={ingredient.id}>
          <span className="ingredient-row__name">
            <strong>{ingredient.name}</strong>
            {ingredient.optional && <small>可选</small>}
            {ingredient.note !== null && <span>{ingredient.note}</span>}
          </span>
          <span className="ingredient-row__amount">
            {quantityFormatter.format(ingredient.quantity)}
            <span aria-hidden="true">&nbsp;</span>
            {ingredient.unit}
          </span>
        </li>
      ))}
    </ul>
  </section>
)
