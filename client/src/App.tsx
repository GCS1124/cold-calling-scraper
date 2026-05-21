import { Toaster } from 'sonner';
import { Navigate, Route, Routes } from 'react-router-dom';

import { AuthPage } from './pages/auth-page';
import { HomePage } from './pages/home-page';
import { searchApi, type SearchApi } from './services/search-service';

type AppProps = {
  searchApi?: SearchApi;
};

export default function App({ searchApi: appSearchApi = searchApi }: AppProps) {
  return (
    <>
      <Routes>
        <Route element={<AuthPage />} path="/" />
        <Route element={<HomePage searchApi={appSearchApi} />} path="/search" />
        <Route element={<Navigate replace to="/" />} path="*" />
      </Routes>
      <Toaster position="top-right" richColors />
    </>
  );
}
