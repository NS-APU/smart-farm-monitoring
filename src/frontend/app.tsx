/**
 * アプリのルート。ログイン状態に応じて、ログイン画面・共通レイアウトつきの画面を切り替える。
 * 画面（SC-xx）は、functional-specification.md 2.1 に対応する。
 */

import { Suspense, lazy, useEffect, type ReactNode } from 'react';
import type { SessionAccess } from './api/client.ts';
import { AuthProvider, useAuth } from './auth/auth-context.tsx';
import { AppLayout } from './components/app-layout.tsx';
import { ErrorBoundary } from './components/error-boundary.tsx';
import { LoadingView } from './components/state-views.tsx';
import { DashboardPage } from './pages/dashboard-page.tsx';
import { LoginPage, loginRedirectPath } from './pages/login-page.tsx';
import { NotFoundPage } from './pages/not-found-page.tsx';
import { NotificationsPage } from './pages/notifications-page.tsx';
import { ObservationsPage } from './pages/observations-page.tsx';
import { SatisfactionPage } from './pages/satisfaction-page.tsx';
import { ViewpointDetailPage } from './pages/viewpoint-detail-page.tsx';
import { PushBrowserProvider } from './push/push-context.tsx';
import type { PushBrowser } from './push/browser-push.ts';
import { PATHS, ROUTE_PATTERNS } from './router/paths.ts';
import { navigate, Routes, useLocation, type RouteDefinition } from './router/router.tsx';

/** 管理系の画面は、必要になったときに読み込む（ダッシュボードの初期表示で、使わない画面のコードを読み込まない。V-080）。 */
const CriteriaEditPage = lazy(() =>
  import('./pages/criteria-edit-page.tsx').then((module) => ({ default: module.CriteriaEditPage })),
);
const DataEntryPage = lazy(() =>
  import('./pages/data-entry-page.tsx').then((module) => ({ default: module.DataEntryPage })),
);
const EntryHistoryPage = lazy(() =>
  import('./pages/entry-history-page.tsx').then((module) => ({ default: module.EntryHistoryPage })),
);
const EntryListPage = lazy(() =>
  import('./pages/entry-list-page.tsx').then((module) => ({ default: module.EntryListPage })),
);
const EquipmentPage = lazy(() =>
  import('./pages/equipment-page.tsx').then((module) => ({ default: module.EquipmentPage })),
);
const IngestionPage = lazy(() =>
  import('./pages/ingestion-page.tsx').then((module) => ({ default: module.IngestionPage })),
);
const StatusCodesPage = lazy(() =>
  import('./pages/status-codes-page.tsx').then((module) => ({ default: module.StatusCodesPage })),
);
const UsersPage = lazy(() =>
  import('./pages/users-page.tsx').then((module) => ({ default: module.UsersPage })),
);
const PushSettingsPage = lazy(() =>
  import('./pages/push-settings-page.tsx').then((module) => ({ default: module.PushSettingsPage })),
);

/** 画面の一覧（機能仕様書 2.1）。 */
export const SCREEN_ROUTES: readonly RouteDefinition[] = [
  { path: PATHS.dashboard, render: () => <DashboardPage /> },
  {
    path: ROUTE_PATTERNS.viewpoint,
    render: (params) => <ViewpointDetailPage viewpointId={params.viewpointId ?? ''} />,
  },
  {
    path: ROUTE_PATTERNS.criteria,
    render: (params) => <CriteriaEditPage viewpointId={params.viewpointId ?? ''} />,
  },
  { path: PATHS.satisfaction, render: () => <SatisfactionPage /> },
  { path: PATHS.notifications, render: () => <NotificationsPage /> },
  { path: PATHS.dataEntry, render: () => <DataEntryPage /> },
  { path: PATHS.dataEntryList, render: () => <EntryListPage /> },
  { path: PATHS.dataEntryHistory, render: () => <EntryHistoryPage /> },
  { path: PATHS.observations, render: () => <ObservationsPage /> },
  { path: PATHS.settingsEquipment, render: () => <EquipmentPage /> },
  { path: PATHS.settingsIngestion, render: () => <IngestionPage /> },
  { path: PATHS.settingsStatusCodes, render: () => <StatusCodesPage /> },
  { path: PATHS.settingsUsers, render: () => <UsersPage /> },
  { path: PATHS.settingsPush, render: () => <PushSettingsPage /> },
];

function Redirect(props: { readonly to: string }): ReactNode {
  const { to } = props;
  useEffect(() => {
    navigate(to, { replace: true });
  }, [to]);
  return null;
}

function AppRoutes(): ReactNode {
  const { user } = useAuth();
  const { pathname, search } = useLocation();

  if (user === null) {
    if (pathname === PATHS.login) {
      return <LoginPage />;
    }
    // 未認証のアクセスは、ログイン画面へ誘導する（戻り先を保持）
    return <Redirect to={loginRedirectPath(pathname, search)} />;
  }
  if (pathname === PATHS.login) {
    return <Redirect to={PATHS.dashboard} />;
  }
  return (
    <AppLayout>
      <ErrorBoundary>
        <Suspense fallback={<LoadingView />}>
          <Routes routes={SCREEN_ROUTES} fallback={<NotFoundPage />} />
        </Suspense>
      </ErrorBoundary>
    </AppLayout>
  );
}

export interface AppProps {
  readonly session: SessionAccess;
  readonly fetchFn: typeof fetch;
  /** Web Push の窓口。指定しなければ、実際のブラウザの機能を使う（テストで差し替える）。 */
  readonly pushBrowser?: PushBrowser;
}

export function App(props: AppProps): ReactNode {
  return (
    <AuthProvider session={props.session} fetchFn={props.fetchFn}>
      <PushBrowserProvider pushBrowser={props.pushBrowser}>
        <AppRoutes />
      </PushBrowserProvider>
    </AuthProvider>
  );
}
