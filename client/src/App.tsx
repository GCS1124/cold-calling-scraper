import { Toaster } from 'sonner';

import { HomePage } from './pages/home-page';
import { searchApi, type SearchApi } from './services/search-service';

type AppProps = {
  searchApi?: SearchApi;
};

export default function App({ searchApi: appSearchApi = searchApi }: AppProps) {
  return (
    <>
      <HomePage searchApi={appSearchApi} />
      <Toaster position="top-right" richColors />
    </>
  );
}
