import { MovieGrid } from '@/components/movie-card';
import { useFavourites } from '@/hooks/useFavourites';

export function FavouritesPage() {
  const { favourites, isLoading } = useFavourites();

  return (
    <div className="w-full max-w-7xl mx-auto px-4 py-6">
      <h1 className="text-2xl font-bold mb-6">Favourites</h1>

      {isLoading ? (
        <div className="text-center py-12">
          <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          <p className="mt-4 text-muted-foreground">Loading favourites...</p>
        </div>
      ) : favourites.length === 0 ? (
        <div className="text-center py-12">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="48"
            height="48"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="mx-auto text-muted-foreground mb-4"
          >
            <path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z" />
          </svg>
          <p className="text-muted-foreground">No favourites yet.</p>
          <p className="text-muted-foreground text-sm mt-1">
            Browse movies and click the heart icon to add them here.
          </p>
        </div>
      ) : (
        <MovieGrid movies={favourites} />
      )}
    </div>
  );
}
