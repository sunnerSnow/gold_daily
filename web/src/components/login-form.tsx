'use client';

import { useActionState } from 'react';
import { loginAction } from '@/app/actions';

export function LoginForm({ next }: { next: string }) {
  const [state, formAction, pending] = useActionState(loginAction, null);
  return (
    <form action={formAction} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <input type="hidden" name="next" value={next} />
      <div className="field">
        <label htmlFor="password">密碼</label>
        <input className="input" type="password" id="password" name="password" autoComplete="current-password" required aria-describedby="login-error" />
      </div>
      <span className="field-error" id="login-error" role="alert">{state && !state.ok ? state.message : ''}</span>
      <button type="submit" className="btn btn--primary" disabled={pending}>{pending ? '登入中…' : '登入'}</button>
    </form>
  );
}
