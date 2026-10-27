import { createContext, useContext, useCallback, type PropsWithChildren } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { useTRPC } from '@/utils/trpc';

export interface FavouriteMovie {
  id: number;
  title: string;
  posterUrl: string | null;
  releaseYear: number | null;
  rating: number;
  overview: string;
}

interface FavouritesContextValue {
  favourites: FavouriteMovie[];
  isLoading: boolean;
  addFavourite: (movie: FavouriteMovie) => void;
  removeFavourite: (movieId: number) => void;
  isFavourite: (movieId: number) => boolean;
  toggleFavourite: (movie: FavouriteMovie) => void;
}

const FavouritesContext = createContext<FavouritesContextValue | null>(null);

export function FavouritesProvider({ children }: PropsWithChildren) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();

  const { data, isLoading } = useQuery(trpc.getFavourites.queryOptions());

  const favourites = data?.favourites ?? [];

  const addMutation = useMutation({
    ...trpc.addFavourite.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.getFavourites.queryKey() });
    },
  });

  const removeMutation = useMutation({
    ...trpc.removeFavourite.mutationOptions(),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: trpc.getFavourites.queryKey() });
    },
  });

  const addFavourite = useCallback(
    (movie: FavouriteMovie) => {
      addMutation.mutate(movie);
    },
    [addMutation],
  );

  const removeFavourite = useCallback(
    (movieId: number) => {
      removeMutation.mutate({ movieId });
    },
    [removeMutation],
  );

  const isFavourite = useCallback(
    (movieId: number) => favourites.some((m) => m.id === movieId),
    [favourites],
  );

  const toggleFavourite = useCallback(
    (movie: FavouriteMovie) => {
      if (isFavourite(movie.id)) {
        removeFavourite(movie.id);
      } else {
        addFavourite(movie);
      }
    },
    [isFavourite, removeFavourite, addFavourite],
  );

  return (
    <FavouritesContext.Provider
      value={{ favourites, isLoading, addFavourite, removeFavourite, isFavourite, toggleFavourite }}
    >
      {children}
    </FavouritesContext.Provider>
  );
}

export function useFavourites() {
  const context = useContext(FavouritesContext);
  if (!context) {
    throw new Error('useFavourites must be used within a FavouritesProvider');
  }
  return context;
}
