/**
 * Step-up (PRD-007 §9, PRD-006 §6.5): actions that change how you sign in
 * need a fresh code. The API decides; this asks for the code in place.
 */
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api/client';
import { qk, useMe } from '../api/hooks';
import { SubmitButton, TextField } from '../auth/AuthLayout';
import { ErrorNote, Panel } from '../components/layout';
import { serverClock } from '../lib/clock';
import { errorText } from '../lib/errors';

/** True while the session's last second-factor check is still fresh (server time). */
export function useFreshStepUp(): boolean {
  const me = useMe();
  const until = me.data?.stepUpUntil ? Date.parse(me.data.stepUpUntil) : 0;
  return until - 5_000 > serverClock.now();
}

export function StepUpPrompt({ reason, onDone }: { reason: string; onDone?: () => void }) {
  const qc = useQueryClient();
  const [code, setCode] = useState('');
  const step = useMutation({
    mutationFn: () => api<{ stepUpUntil: string }>('/auth/step-up', { body: { code: code.replace(/\s+/g, '') } }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: qk.me, refetchType: 'all' });
      onDone?.();
    },
  });
  return (
    <Panel className="flex flex-col gap-3">
      <h2 className="m-0 font-mono text-[13px] font-medium tracking-[1px]">CONFIRM IT’S YOU</h2>
      <p className="m-0 text-[14px] leading-[1.45]">{reason} Enter a code from your authenticator app, or one of your backup codes.</p>
      <form onSubmit={(e) => (e.preventDefault(), step.mutate())} className="flex flex-col gap-3" noValidate>
        <TextField label="Code" inputMode="text" autoComplete="one-time-code" maxLength={14} required value={code} onChange={(e) => setCode(e.target.value)} />
        <ErrorNote>{step.isError ? errorText(step.error) : null}</ErrorNote>
        <SubmitButton busy={step.isPending} disabled={code.replace(/\s/g, '').length < 6}>CONFIRM</SubmitButton>
      </form>
    </Panel>
  );
}
