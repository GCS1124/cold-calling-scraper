import { lazy, Suspense } from 'react';
import { Toaster } from 'sonner';
import { Navigate, Route, Routes } from 'react-router-dom';

import { searchApi, type SearchApi } from './services/search-service';

const AuthPage = lazy(() => import('./pages/auth-page').then(({ AuthPage: page }) => ({ default: page })));
const HistoryPage = lazy(() =>
  import('./pages/history-page').then(({ HistoryPage: page }) => ({ default: page })),
);
const HomePage = lazy(() => import('./pages/home-page').then(({ HomePage: page }) => ({ default: page })));

function RouteLoadingFallback() {
  return (
    <main
      aria-busy="true"
      className="grid min-h-[100dvh] place-items-center bg-slate-50 p-6 text-slate-600"
    >
      <p className="rounded-2xl border border-slate-200 bg-white px-5 py-3 text-sm font-semibold shadow-sm">
        Loading workspace…
      </p>
    </main>
  );
}

type AppProps = {
  searchApi?: SearchApi;
};

export default function App({ searchApi: appSearchApi = searchApi }: AppProps) {
  return (
    <>
      <Suspense fallback={<RouteLoadingFallback />}>
        <Routes>
          <Route element={<AuthPage />} path="/" />
          <Route element={<HomePage searchApi={appSearchApi} />} path="/search" />
          <Route element={<HistoryPage />} path="/history" />
          <Route element={<Navigate replace to="/" />} path="*" />
        </Routes>
      </Suspense>
      <Toaster position="top-right" richColors />
    </>
  );
}
