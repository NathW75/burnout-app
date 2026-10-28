import { useId, type InputHTMLAttributes, type ReactNode } from 'react';
import { Link } from 'react-router';
import { Page, Wordmark } from '../components/layout';

export function AuthLayout({ title, intro, children, steps }: { title: string; intro?: ReactNode; children: ReactNode; steps?: ReactNode }) {
  return (
    <Page>
      <header className="flex items-center justify-between border-b border-accent bg-chrome px-4 py-[14px]">
        <Link to="/" className="no-underline" aria-label="Burnout League home">
          <Wordmark />
        </Link>
      </header>
      <main className="flex flex-1 flex-col gap-5 px-4 pt-6 pb-24">
        {steps}
        <div className="flex flex-col gap-2">
          <h1 className="m-0 font-mono text-[30px] leading-[1.1] font-medium tracking-[-0.5px]">{title}</h1>
          {intro && <div className="m-0 text-[14px] leading-[1.5] text-muted">{intro}</div>}
        </div>
        {children}
      </main>
    </Page>
  );
}

/** Sign-up progress: 01 ACCOUNT · 02 VERIFY · 03 AUTHENTICATOR · 04 BACKUP CODES. */
export function SignupSteps({ current }: { current: 1 | 2 | 3 | 4 }) {
  const steps = ['ACCOUNT', 'VERIFY', 'AUTHENTICATOR', 'BACKUP CODES'];
  return (
    <ol aria-label="Sign-up steps" className="m-0 grid list-none grid-cols-4 gap-[6px] p-0">
      {steps.map((s, i) => {
        const n = i + 1;
        return (
          <li key={s} aria-current={n === current ? 'step' : undefined} className="flex flex-col gap-[6px]">
            <span className={`h-[3px] ${n <= current ? 'bg-accent' : 'bg-rule'}`} />
            <span className={`font-mono text-[10px] ${n === current ? 'text-accent' : 'text-muted'}`}>
              {String(n).padStart(2, '0')} {s}
              {n < current && <span className="sr-only"> (done)</span>}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

interface FieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  hint?: ReactNode;
  error?: string | null;
}

export function TextField({ label, hint, error, ...input }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errId = error ? `${id}-err` : undefined;
  return (
    <div className="flex flex-col gap-[6px]">
      <label htmlFor={id} className="font-mono text-[11px] tracking-[1px] text-muted">
        {label.toUpperCase()}
      </label>
      <input
        id={id}
        className={`field ${error ? 'border-pencil' : ''}`}
        aria-describedby={[hintId, errId].filter(Boolean).join(' ') || undefined}
        aria-invalid={error ? true : undefined}
        {...input}
      />
      {hint && (
        <span id={hintId} className="text-[12px] text-muted">
          {hint}
        </span>
      )}
      {error && (
        <span id={errId} className="text-[12px] text-pencil">
          {error}
        </span>
      )}
    </div>
  );
}

export function SubmitButton({ children, busy, disabled }: { children: ReactNode; busy?: boolean; disabled?: boolean }) {
  return (
    <button type="submit" className="btn-primary w-full disabled:opacity-60" disabled={busy || disabled} aria-busy={busy || undefined}>
      {busy ? 'ONE MOMENT…' : children}
    </button>
  );
}
