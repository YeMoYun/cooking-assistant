import { useId, type FormEvent } from 'react'

export type RecipeSearchBarProps = Readonly<{
  onChange: (value: string) => void
  onSubmit: (value: string) => void
  value: string
}>

export const RecipeSearchBar = ({
  onChange,
  onSubmit,
  value,
}: RecipeSearchBarProps) => {
  const inputId = useId()

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault()
    onSubmit(value)
  }

  return (
    <form className="recipe-search" onSubmit={handleSubmit} role="search">
      <label className="visually-hidden" htmlFor={inputId}>
        搜索菜名、食材或口味
      </label>
      <div className="recipe-search__field">
        <svg
          aria-hidden="true"
          className="recipe-search__icon"
          fill="none"
          viewBox="0 0 24 24"
        >
          <circle cx="10.5" cy="10.5" r="6.5" />
          <path d="m15.5 15.5 5 5" />
        </svg>
        <input
          aria-label="搜索菜名、食材或口味"
          autoComplete="off"
          enterKeyHint="search"
          id={inputId}
          maxLength={100}
          onChange={(event) => onChange(event.currentTarget.value)}
          placeholder="搜索菜名、食材或口味"
          type="search"
          value={value}
        />
      </div>
      <button className="recipe-search__submit" type="submit">
        搜索
      </button>
    </form>
  )
}
