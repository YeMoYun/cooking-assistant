import type { ContextSelection } from '@xiaochu/shared';

interface ContextPickerProps {
  readonly value: ContextSelection;
  readonly onChange: (next: ContextSelection) => void;
}

export const ContextPicker = ({ value, onChange }: ContextPickerProps) => (
  <fieldset className="assistant-context">
    <legend>可选上下文（默认不发送）</legend>
    <p>仅将你选中的本地数据提供给这一次对话；关闭后不会被模型看到。</p>
    <label>
      <input
        checked={value.includeInventory}
        onChange={(event) => onChange({ ...value, includeInventory: event.target.checked })}
        type="checkbox"
      />
      允许读取冰箱库存
    </label>
    <label>
      <input
        checked={value.includeShopping}
        onChange={(event) => onChange({ ...value, includeShopping: event.target.checked })}
        type="checkbox"
      />
      允许读取购物清单
    </label>
  </fieldset>
);
