'use client';

import { useActionState } from 'react';
import type { ActionState } from '@/app/actions';

// 單一按鈕的 Server Action 表單，執行中停用按鈕並顯示結果。

type Action = (prev: ActionState, formData: FormData) => Promise<ActionState>;

export function ActionButton({
  action,
  label,
  pendingLabel = '處理中…',
  fields = {},
  variant,
  confirm,
  hint,
}: {
  action: Action;
  label: string;
  pendingLabel?: string;
  fields?: Record<string, string>;
  variant?: 'primary' | 'small';
  confirm?: string;
  hint?: string;
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form
      action={formAction}
      onSubmit={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault();
      }}
      style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-start' }}
    >
      {Object.entries(fields).map(([k, v]) => (
        <input key={k} type="hidden" name={k} value={v} />
      ))}
      <button type="submit" className={`btn${variant === 'primary' ? ' btn--primary' : ''}${variant === 'small' ? ' btn--sm' : ''}`} disabled={pending}>
        {pending ? pendingLabel : label}
      </button>
      {hint ? <span className="help">{hint}</span> : null}
      <span className={`small ${state ? (state.ok ? 'soft' : '') : ''}`} role="status" aria-live="polite" style={state && !state.ok ? { color: 'var(--err)' } : undefined}>
        {state?.message ?? ''}
      </span>
    </form>
  );
}
