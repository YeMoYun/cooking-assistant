import type { RecipeDetail } from '@xiaochu/shared'

type RecipeStep = RecipeDetail['steps'][number]

export type RecipeStepsProps = Readonly<{
  steps: RecipeDetail['steps']
}>

const formatDuration = (seconds: number): string => {
  if (seconds < 60) {
    return `${seconds} 秒`
  }
  const minutes = Math.floor(seconds / 60)
  const remainder = seconds % 60
  return remainder === 0
    ? `${minutes} 分钟`
    : `${minutes} 分 ${remainder} 秒`
}

const formatDurationRange = (minimum: number, maximum: number): string => (
  minimum === maximum
    ? formatDuration(minimum)
    : `${formatDuration(minimum)}–${formatDuration(maximum)}`
)

const StepGuidance = ({ step }: { readonly step: RecipeStep }) => (
  <dl className="step-guidance">
    <div>
      <dt>预计时间</dt>
      <dd>{formatDurationRange(step.durationSecondsMin, step.durationSecondsMax)}</dd>
    </div>
    <div>
      <dt>火力或设备</dt>
      <dd>{step.heatOrDevice}</dd>
    </div>
    <div>
      <dt>做到什么状态</dt>
      <dd>{step.completionCue}</dd>
    </div>
    <div>
      <dt>常见错误</dt>
      <dd>{step.commonMistake}</dd>
    </div>
    <div className="step-guidance__safety">
      <dt>安全要求</dt>
      <dd>{step.safetyRequirement}</dd>
    </div>
  </dl>
)

export const RecipeSteps = ({ steps }: RecipeStepsProps) => (
  <section aria-labelledby="recipe-steps-title" className="detail-section">
    <header className="detail-section__heading">
      <div>
        <h2 id="recipe-steps-title">完整步骤</h2>
        <p>每一步都写明时间、火候、完成判断和失败避坑。</p>
      </div>
      <span>{steps.length} 步</span>
    </header>

    <ol className="recipe-steps">
      {steps.map((step) => (
        <li className="recipe-step" key={step.id}>
          <div aria-hidden="true" className="recipe-step__number">
            {String(step.number).padStart(2, '0')}
          </div>
          <div className="recipe-step__content">
            <h3>第 {step.number} 步</h3>
            <p className="recipe-step__instruction">{step.instruction}</p>
            {step.ingredientNames.length > 0 && (
              <p className="recipe-step__ingredients">
                <strong>这一步用到：</strong>
                {step.ingredientNames.join('、')}
              </p>
            )}
            <StepGuidance step={step} />
          </div>
        </li>
      ))}
    </ol>
  </section>
)
