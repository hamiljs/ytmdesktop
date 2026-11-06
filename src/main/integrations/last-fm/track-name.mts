// Turns what YouTube Music reports for a video into the artist and track name Last.fm
// knows. Official audio tracks are already clean. Music videos and user uploads are not:
// the channel can be "DaftPunkVEVO" or "Daft Punk - Topic", and the title can carry
// "(Official Video)" or the artist itself ("Daft Punk - One More Time").
//
// Pure functions with no Electron imports, so `node --test` can run the tests directly.

export type RawTrack = {
  title: string;
  author: string;
  album: string | null;
  // VideoType from the player state: 0 = official audio track, 1 = music video, others = uploads/unknown
  videoType: number;
};

export type CleanTrack = {
  artist: string;
  track: string;
  album?: string;
};

const MUSIC_AUDIO = 0;

// Bracketed noise in titles. Anything bracketed that names a real version
// ("Remastered 2011", "Live", "Acoustic", "feat. X", "Remix") stays.
const BRACKET_NOISE =
  /\s*[([](?:official\s*)?(?:hd\s*|4k\s*|hq\s*)?(?:music\s*video|video\s*clip|video|audio|lyric(?:s)?\s*video|lyrics?|visuali[sz]er|(?:official\s*)?mv|hd|4k|hq|explicit|clean)(?:\s*(?:hd|4k|hq))?[)\]]/gi;
// Trailing "| Official Video" or "// Official Audio" style suffixes.
const SUFFIX_NOISE =
  /\s*(?:\||\/\/)\s*(?:official\s*)?(?:music\s*video|video|audio|lyric\s*video|lyrics?|visuali[sz]er).*$/i;
const DASH_SPLIT = /^(.+?)\s+[-–—]\s+(.+)$/;

export function cleanAuthor(author: string): string {
  let a = author.trim().replace(/\s+-\s+Topic$/i, '');
  if (/VEVO$/i.test(a)) {
    a = a.replace(/VEVO$/i, '');
    // VEVO channel names drop spaces: "DaftPunk" -> "Daft Punk"
    if (!/\s/.test(a)) a = a.replace(/([a-z])([A-Z])/g, '$1 $2');
  }
  return a.replace(/\s*\(?official\)?$/i, '').trim() || author.trim();
}

export function cleanTitle(title: string): string {
  const t = title
    .replace(BRACKET_NOISE, '')
    .replace(SUFFIX_NOISE, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return t || title.trim();
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

export function cleanTrack(raw: RawTrack): CleanTrack {
  const album = raw.album?.trim() || undefined;
  if (raw.videoType === MUSIC_AUDIO) {
    return { artist: cleanAuthor(raw.author), track: raw.title.trim(), album };
  }

  const author = cleanAuthor(raw.author);
  const title = cleanTitle(raw.title);

  // "Artist - Track": trust the split when the left side matches the channel, or the
  // channel is a VEVO/Topic/label channel that says nothing about the artist.
  const m = DASH_SPLIT.exec(title);
  if (m) {
    const [, left, right] = m;
    const channelIsGeneric = /VEVO$|\s-\sTopic$|records|music|official/i.test(
      raw.author,
    );
    const leftMatchesAuthor =
      squash(left).length > 0 &&
      (squash(author).includes(squash(left)) ||
        squash(left).includes(squash(author)));
    if (leftMatchesAuthor || channelIsGeneric) {
      return { artist: left.trim(), track: right.trim(), album };
    }
  }

  return { artist: author, track: title, album };
}

// Radio and autoplay picks are not the listener's choice. A radio playlist id starts
// with "RD"; the seed song of "start radio from this song" is RDAMVM<videoId> and was chosen.
export function chosenByUser(
  playlistId: string | null,
  videoId: string,
): boolean {
  if (!playlistId || !playlistId.startsWith('RD')) return true;
  return playlistId === `RDAMVM${videoId}` || playlistId === `RDAMPL${videoId}`;
}
