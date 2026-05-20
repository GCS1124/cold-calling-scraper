import { expandQueryWithGemini } from './gemini';
import { googlePlacesProvider } from './google-places';
import { yellowPagesProvider } from './yellowpages';
import { yelpProvider } from './yelp';

export const defaultProviders = [
  googlePlacesProvider,
  yelpProvider,
  yellowPagesProvider,
];

export { expandQueryWithGemini };
