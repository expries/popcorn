import { createRootRoute, createRoute, createRouter } from '@tanstack/react-router';
import { z } from 'zod';

import { Layout } from './layout';
import { IndexPage } from './pages';
import { MoviePage } from './pages/movie';
import { CollectionsPage } from './pages/collections';
import { FavouritesPage } from './pages/favourites';
import { SearchPage } from './pages/search';
import { WatchPage } from './pages/watch';

const rootRoute = createRootRoute({ component: Layout });

const indexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/',
  validateSearch: z.object({
    q: z.string().optional(),
  }),
  component: IndexPage,
});

const movieRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/movie',
  validateSearch: z.object({
    id: z.number().optional(),
    year: z.number().optional(),
  }),
  component: MoviePage,
});

const collectionsRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/collections',
  component: CollectionsPage,
});

const favouritesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/favourites',
  component: FavouritesPage,
});

const searchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/search',
  validateSearch: z.object({
    q: z.string().optional(),
  }),
  component: SearchPage,
});

const watchRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: '/watch',
  validateSearch: z.object({
    torrentUrl: z.string().optional(),
    magnetUrl: z.string().optional(),
    link: z.string().optional(),
    url: z.string().optional(),
    infoHash: z.string().optional(),
    movieId: z.number().optional(),
  }),
  component: WatchPage,
});

const routeTree = rootRoute.addChildren([indexRoute, movieRoute, collectionsRoute, favouritesRoute, searchRoute, watchRoute]);

export const router = createRouter({ routeTree });
