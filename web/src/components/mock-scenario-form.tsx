'use client';

import { useActionState } from 'react';
import type { ActionState } from '@/app/actions';

export function MockScenarioForm({
  action,
  current,
  options,
}: {
  action: (prev: ActionState, formData: FormData) => Promise<ActionState>;
  current: string;
  options: { value: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(action, null);
  return (
    <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <label className="field">
        <span className="field__label">Mock 行情情境</span>
        <select key={current} className="input" name="mockScenario" defaultValue={current}>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" className="btn" disabled={pending} style={{ alignSelf: 'flex-start' }}>
        {pending ? '套用中…' : '套用情境'}
      </button>
      <span className="small" role="status" aria-live="polite">{state?.message ?? ''}</span>
    </form>
  );
}
