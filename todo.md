# Popcorn To do list

Investigate and implement or fix the following items. Create commits according to the "conventional commits" style when appriopriate.

## Movie page

- URL should be /movie/<movie_id> instead of /movie?id=<movide_id>&year=<year>
- Implement simple parsing of torrent details to display tags like H265, H264, HDR, etc.
- Display movie duration (if not included in TMDB response, ask before implementing)

## Watch page

- In the seeking overlay (when seeking past available content), do not display a progress bar.

- when video is bfuffering, display player with total duration 0:00, but keep buffering text

- hide video controls after mouse not moving

- to be confirmed: After buffering (after the status "downloading from bittorrent network" is gone and "streaming available" is the new status), I can hit play

## Collections page

- Movie name + year should be displayed for collection enties, not torrent name. Include ID as small text for item
- Show same tags as from movie page
