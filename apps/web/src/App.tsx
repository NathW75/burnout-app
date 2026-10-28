import { QueryClientProvider } from '@tanstack/react-query';
import { lazy, Suspense, useState } from 'react';
import { BrowserRouter, Link, Route, Routes } from 'react-router';
import { createQueryClient } from './api/hooks';
import { GuestOnly, RequireAccount, RequireSignedIn } from './auth/guards';
import { ForgotPasswordPage, LoginCodePage, LoginPage, ResetPasswordPage, SignUpPage, VerifyEmailPage, VerifyPendingPage } from './auth/pages';
import { WelcomePage } from './auth/Welcome';
import { Loading, Page, useScreen } from './components/layout';
import { LineupRoutes } from './lineup/context';
import { BuilderPage } from './lineup/Builder';
import { PickerPage } from './lineup/Picker';
import { useClockSync } from './lib/useClock';
import { ThisWeekPage } from './pages/ThisWeek';

// Loaded on demand (PRD-007 §9): the gates, the authenticator setup (QR encoder), receipts, rules, account, standings, burned roster and inbox.
const Setup2FAPage = lazy(() => import('./auth/Setup2FA').then((m) => ({ default: m.Setup2FAPage })));
const Gate1Page = lazy(() => import('./lineup/Gates').then((m) => ({ default: m.Gate1Page })));
const Gate2Page = lazy(() => import('./lineup/Gates').then((m) => ({ default: m.Gate2Page })));
const Gate3Page = lazy(() => import('./lineup/Gates').then((m) => ({ default: m.Gate3Page })));
const ReceiptPage = lazy(() => import('./pages/Receipt').then((m) => ({ default: m.ReceiptPage })));
const HelpPage = lazy(() => import('./pages/Help').then((m) => ({ default: m.HelpPage })));
const AccountPage = lazy(() => import('./pages/Account').then((m) => ({ default: m.AccountPage })));
const StandingsPage = lazy(() => import('./pages/Standings').then((m) => ({ default: m.StandingsPage })));
const ManagerPage = lazy(() => import('./pages/Manager').then((m) => ({ default: m.ManagerPage })));
const BurnedPage = lazy(() => import('./pages/Burned').then((m) => ({ default: m.BurnedPage })));
const InboxPage = lazy(() => import('./pages/Inbox').then((m) => ({ default: m.InboxPage })));
const PasswordPage = lazy(() => import('./account/Security').then((m) => ({ default: m.PasswordPage })));
const AuthenticatorPage = lazy(() => import('./account/Security').then((m) => ({ default: m.AuthenticatorPage })));
const BackupCodesPage = lazy(() => import('./account/Security').then((m) => ({ default: m.BackupCodesPage })));
const SessionsPage = lazy(() => import('./account/Sessions').then((m) => ({ default: m.SessionsPage })));
const ReceiptsPage = lazy(() => import('./account/Sessions').then((m) => ({ default: m.ReceiptsPage })));
const NotificationsPage = lazy(() => import('./account/Notifications').then((m) => ({ default: m.NotificationsPage })));
const UnsubscribePage = lazy(() => import('./account/Notifications').then((m) => ({ default: m.UnsubscribePage })));
const InvitesPage = lazy(() => import('./admin/Invites').then((m) => ({ default: m.InvitesPage })));

function NotFound() {
  useScreen('not_found', 'Not found');
  return (
    <Page className="items-start gap-4 p-6">
      <h1 className="m-0 font-mono text-[30px] font-medium">Nothing here.</h1>
      <Link to="/" className="btn-primary px-6">TO THIS WEEK</Link>
    </Page>
  );
}

export function AppRoutes() {
  useClockSync();
  return (
    <Suspense fallback={<Page><Loading /></Page>}>
    <Routes>
      <Route element={<GuestOnly />}>
        <Route path="/signup" element={<SignUpPage />} />
        <Route path="/login" element={<LoginPage />} />
      </Route>
      <Route path="/login/code" element={<LoginCodePage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route element={<RequireSignedIn />}>
        <Route path="/verify-pending" element={<VerifyPendingPage />} />
        <Route path="/setup-2fa" element={<Setup2FAPage />} />
      </Route>
      <Route element={<RequireAccount />}>
        <Route path="/" element={<ThisWeekPage />} />
        <Route path="/welcome" element={<WelcomePage />} />
        <Route path="/lineup" element={<LineupRoutes />}>
          <Route index element={<BuilderPage />} />
          <Route path="pick/:slot" element={<PickerPage />} />
          <Route path="review" element={<Gate1Page />} />
          <Route path="acknowledge" element={<Gate2Page />} />
          <Route path="confirm" element={<Gate3Page />} />
        </Route>
        <Route path="/receipts/:id" element={<ReceiptPage />} />
        <Route path="/help" element={<HelpPage />} />
        <Route path="/account" element={<AccountPage />} />
        <Route path="/account/password" element={<PasswordPage />} />
        <Route path="/account/authenticator" element={<AuthenticatorPage />} />
        <Route path="/account/backup-codes" element={<BackupCodesPage />} />
        <Route path="/account/sessions" element={<SessionsPage />} />
        <Route path="/account/receipts" element={<ReceiptsPage />} />
        <Route path="/account/notifications" element={<NotificationsPage />} />
        <Route path="/admin/invites" element={<InvitesPage />} />
        <Route path="/board" element={<StandingsPage />} />
        <Route path="/board/:handle" element={<ManagerPage />} />
        <Route path="/burned" element={<BurnedPage />} />
        <Route path="/inbox" element={<InboxPage />} />
      </Route>
      {/* Public: the email's unsubscribe link works signed in or out (PRD-008 §5). */}
      <Route path="/unsubscribe" element={<UnsubscribePage />} />
      <Route path="*" element={<NotFound />} />
    </Routes>
    </Suspense>
  );
}

export function App() {
  const [client] = useState(createQueryClient);
  return (
    <QueryClientProvider client={client}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
