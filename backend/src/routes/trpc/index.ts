import { fetchTorrentInfo } from '../fetchTorrentInfo';
import { queryTorrents } from '../queryTorrents';
import { searchMovies, getMovie, getPopularMovies } from '../searchMovies';
import {
  addTorrent,
  getAllDownloads,
  getAllTorrents,
  getTorrentStats,
  getVideoInfo,
  isVideoAvailable,
  removeTorrent,
  restartTranscoding,
  scanVideos,
  startTorrent,
  stopTorrent,
} from '../torrent';
import { getFavourites, addFavourite, removeFavourite, isFavourite } from '../favourites';
import { t } from '../../trpc';

export const appRouter = t.router({
  // Movie search (TMDB)
  searchMovies,
  getMovie,
  getPopularMovies,
  // Torrent search
  queryTorrents,
  fetchTorrentInfo,
  // Torrent management
  addTorrent,
  getTorrentStats,
  getAllTorrents,
  getAllDownloads,
  startTorrent,
  stopTorrent,
  removeTorrent,
  restartTranscoding,
  // Video streaming
  getVideoInfo,
  isVideoAvailable,
  scanVideos,
  // Favourites
  getFavourites,
  addFavourite,
  removeFavourite,
  isFavourite,
});

export type AppRouter = typeof appRouter;
