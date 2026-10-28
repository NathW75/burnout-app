/**
 * Admin → Feedback (PRD-007 §10, SPEC-feedback-system "Admin View"): every
 * piece of tester feedback, newest first, with the model's category, severity
 * and summary when tagging is on. Filter by reviewed and category; mark reviewed.
 * Admin only, behind a fresh code (step-up), as the API requires.
 */
import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, isApiError } from '../api/client';
import { useMe } from '../api/hooks';
import { StepUpPrompt, useFreshStepUp } from '../account/StepUp';
import { AccountSubPage } from '../account/Security';
import { ErrorNote, Loading, useScreen } from '../components/layout';
import { errorText } from '../lib/errors';
import { fullET } from '../lib/format';

type Category = 'bug' | 'feature_request' | 'ux_confusion' | 'positive' | 'other';
interface FeedbackItem {
  id: string;
  submittedAt: string;
  handle: string | null;
  displayName: string;
  screen: string;
  body: string;
  tags: { category: Category; severity: 'critical' | 'high' | 'medium' | 'low' | null; summary: string; screen_relevant: boolean } | null;
  reviewed: boolean;
}
interface Page { items: FeedbackItem[]; nextBefore: string | null }

const CATEGORIES: Array<{ value: '' | Category; label: string }> = [
  { value: '', label: 'All categories' },
  { value: 'bug', label: 'Bugs' },
  { value: 'ux_confusion', label: 'Confusing' },
  { value: 'feature_request', label: 'Feature requests' },
  { value: 'positive', label: 'Positive' },
  { value: 'other', label: 'Other' },
];
const CATEGORY_TONE: Record<Category, string> = { bug: 'text-pencil', ux_confusion: 'text-live', feature_request: 'text-accent', positive: 'text-accent', other: 'text-muted' };

export function FeedbackAdminPage() {
  useScreen('admin_feedback', 'Feedback');
  const me = useMe();
  const qc = useQueryClient();
  const fresh = useFreshStepUp();
  const [unreviewed, setUnreviewed] = useState(true);
  const [category, setCategory] = useState<'' | Category>('');
  const isAdmin = me.data?.role === 'admin';
  const key = ['admin', 'feedback', unreviewed, category];
  const list = useInfiniteQuery({
    queryKey: key,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ limit: '30' });
      if (unreviewed) q.set('reviewed', 'false');
      if (category) q.set('category', category);
      if (pageParam) q.set('before', pageParam);
      return api<Page>(`/admin/feedback?${q}`);
    },
    getNextPageParam: (last) => last.nextBefore,
    enabled: isAdmin && fresh,
    retry: false,
  });
  const review = useMutation({
    mutationFn: ({ id, reviewed }: { id: string; reviewed: boolean }) => api(`/admin/feedback/${id}/review`, { body: { reviewed } }),
    onSettled: () => qc.invalidateQueries({ queryKey: ['admin', 'feedback'] }),
  });

  if (me.data && !isAdmin) return <AccountSubPage title="FEEDBACK" heading="Feedback"><ErrorNote>Only an admin can read feedback.</ErrorNote></AccountSubPage>;
  const stale = [list.error, review.error].some((e) => isApiError(e, 'STEP_UP_REQUIRED'));
  if (!fresh || stale) {
    return (
      <AccountSubPage title="FEEDBACK" heading="Feedback">
        <StepUpPrompt reason="Reading feedback needs a fresh code." onDone={() => { review.reset(); void qc.invalidateQueries({ queryKey: ['admin', 'feedback'] }); }} />
      </AccountSubPage>
    );
  }
  const items = list.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <AccountSubPage title="FEEDBACK" heading="Feedback" intro="What testers sent from the feedback button, newest first. You also get an email for each one.">
      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Show" className="flex overflow-hidden rounded-sm border border-frame">
          {[true, false].map((u) => (
            <button
              key={String(u)}
              type="button"
              aria-pressed={unreviewed === u}
              onClick={() => setUnreviewed(u)}
              className={`min-h-11 px-3 font-mono text-[12px] ${unreviewed === u ? 'bg-type text-newsprint' : 'bg-paper text-type'}`}
            >
              {u ? 'UNREVIEWED' : 'ALL'}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-2 font-mono text-[12px] text-muted">
          <span className="sr-only">Category</span>
          <select
            className="min-h-11 rounded-sm border border-frame bg-paper px-2 font-mono text-[13px] text-type"
            value={category}
            onChange={(e) => setCategory(e.target.value as '' | Category)}
          >
            {CATEGORIES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </label>
      </div>
      {list.error && !stale && <ErrorNote>{errorText(list.error)}</ErrorNote>}
      {review.isError && !stale && <ErrorNote>{errorText(review.error)}</ErrorNote>}
      {!list.data ? (
        <Loading />
      ) : items.length === 0 ? (
        <p className="m-0 rounded-sm border border-dashed border-frame p-[14px] text-[14px] text-muted">
          {unreviewed ? 'Nothing waiting. Every piece of feedback has been reviewed.' : 'No feedback yet.'}
        </p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0" aria-label="Feedback">
          {items.map((f) => (
            <li key={f.id} className={`flex flex-col gap-2 rounded-sm border px-[14px] py-3 ${f.reviewed ? 'border-rule bg-paper' : 'border-l-[3px] border-frame border-l-accent bg-paper'}`}>
              <span className="flex flex-wrap items-center gap-2 font-mono text-[11px] font-medium">
                {f.tags ? (
                  <>
                    <span className={CATEGORY_TONE[f.tags.category]}>{f.tags.category.replace('_', ' ').toUpperCase()}</span>
                    {f.tags.severity && <span className={f.tags.severity === 'critical' || f.tags.severity === 'high' ? 'text-pencil' : 'text-muted'}>· {f.tags.severity.toUpperCase()}</span>}
                  </>
                ) : (
                  <span className="text-muted">NOT TAGGED</span>
                )}
                {f.reviewed && <span className="text-muted">· REVIEWED</span>}
              </span>
              {f.tags && <span className="text-[14px] font-semibold">{f.tags.summary}</span>}
              <p className="m-0 text-[14px] leading-[1.5] whitespace-pre-wrap break-words">{f.body}</p>
              <span className="text-[12px] text-muted">{f.handle ?? f.displayName} · {f.screen} · {fullET(f.submittedAt)}</span>
              <button
                type="button"
                className="btn-outline min-h-11 self-start px-3"
                disabled={review.isPending}
                onClick={() => review.mutate({ id: f.id, reviewed: !f.reviewed })}
              >
                {f.reviewed ? 'MARK UNREVIEWED' : 'MARK REVIEWED'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {list.hasNextPage && (
        <button type="button" className="btn-outline min-h-11 w-full" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
          {list.isFetchingNextPage ? 'LOADING…' : 'OLDER'}
        </button>
      )}
    </AccountSubPage>
  );
}
