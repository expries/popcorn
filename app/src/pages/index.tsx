import { useState, useEffect } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';

import { Input } from '@/components/input';
import { Button } from '@/components/button';
import { MovieGrid } from '@/components/movie-card';
import { useTRPC } from '@/utils/trpc';
import { cn } from '@/utils/styles';

export function IndexPage() {
  const navigate = useNavigate();
  const search = useSearch({ from: '/' });
  const trpc = useTRPC();

  const searchQuery = search.q ?? '';
  const [inputValue, setInputValue] = useState<string>(searchQuery);

  // Sync input with URL query parameter
  useEffect(() => {
    setInputValue(searchQuery);
  }, [searchQuery]);

  const { data: searchResults, isLoading: isSearching } = useQuery({
    ...trpc.searchMovies.queryOptions({ query: searchQuery }),
    enabled: searchQuery.length > 0,
  });

  const { data: popularMovies, isLoading: isLoadingPopular } = useQuery({
    ...trpc.getPopularMovies.queryOptions({}),
    enabled: searchQuery.length === 0,
  });

  const handleTitleChange = (event: { target: { value: string } }) => {
    setInputValue(event.target.value);
  };

  const handleSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    const query = inputValue.trim();
    if (query.length > 0) {
      navigate({ to: '/', search: { q: query } });
    } else {
      navigate({ to: '/', search: {} });
    }
  };

  const movies = searchQuery ? searchResults?.movies : popularMovies?.movies;
  const isLoading = searchQuery ? isSearching : isLoadingPopular;

  return (
    <div className="w-full max-w-7xl mx-auto px-4 py-6">
      <form
        onSubmit={handleSubmit}
        className="flex items-center gap-2 bg-card p-3 rounded-xl font-mono border border-input w-full max-w-2xl mx-auto mb-8"
      >
        <Input
          type="text"
          name="q"
          value={inputValue}
          className={cn(
            'flex-1 font-mono',
            'bg-transparent border-0 shadow-none',
            'focus-visible:ring-0 focus-visible:ring-offset-0',
          )}
          placeholder="Search movies..."
          onChange={handleTitleChange}
        />

        <Button type="submit" variant="secondary">
          Search
        </Button>
      </form>

      <div className="mb-6">
        <h2 className="text-xl font-semibold mb-4">
          {searchQuery ? `Results for "${searchQuery}"` : 'Popular Movies'}
        </h2>

        {isLoading ? (
          <div className="text-center py-12">
            <div className="inline-block animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
            <p className="mt-4 text-muted-foreground">Loading movies...</p>
          </div>
        ) : (
          <MovieGrid movies={movies ?? []} />
        )}
      </div>
    </div>
  );
}
