import protectedapimanager from '../protectedapimanager';

// HDC fork: requests from the agent socket (main process) that need YouTube Music's own
// data. They go through the page's own request machinery ("yt-service-request"), the same
// path the page uses when you type in the search box, so nothing new talks to Google.

// YouTube Music's search filter chips
const SEARCH_FILTERS: Record<string, string | undefined> = {
  all: undefined,
  songs: 'EgWKAQIIAWoKEAkQBRAKEAMQBA==',
  videos: 'EgWKAQIQAWoKEAkQChAFEAMQBA==',
  albums: 'EgWKAQIYAWoKEAkQAxAEEAoQBQ==',
  playlists: 'EgeKAQQoAEABagoQCRAKEAUQAxAE',
};

export type AgentSearchResult = {
  kind: 'song' | 'video' | 'album' | 'playlist' | 'artist' | 'other';
  videoId: string | null;
  playlistId: string | null;
  browseId: string | null;
  title: string;
  artists: string[];
  detail: string;
};

function serviceRequest(endpoint: object): Promise<any> {
  const app = document.querySelector('ytmusic-app');
  if (!app) return Promise.reject(new Error('YouTube Music page not ready'));
  const returnValue: any[] = [];
  app.dispatchEvent(
    new CustomEvent('yt-action', {
      bubbles: true,
      cancelable: false,
      composed: true,
      detail: {
        actionName: 'yt-service-request',
        args: [app, endpoint],
        optionalAction: false,
        returnValue,
      },
    }),
  );
  const pending = returnValue[0]?.ajaxPromise;
  if (!pending)
    return Promise.reject(
      new Error('YouTube Music did not accept the request'),
    );
  return new Promise((resolve, reject) =>
    pending.then((r: any) => resolve(r?.data ?? r), reject),
  );
}

const runsText = (runs: any[] | undefined) =>
  (runs ?? []).map((r) => r.text).join('');

function parseListItem(item: any): AgentSearchResult | null {
  const columns: any[] = item.flexColumns ?? [];
  const titleRuns =
    columns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs;
  const detailRuns: any[] =
    columns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs ?? [];
  const title = runsText(titleRuns);
  if (!title) return null;

  const watch =
    item.overlay?.musicItemThumbnailOverlayRenderer?.content
      ?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint ??
    titleRuns?.[0]?.navigationEndpoint?.watchEndpoint;
  const browse = item.navigationEndpoint?.browseEndpoint;
  const pageType: string =
    browse?.browseEndpointContextSupportedConfigs
      ?.browseEndpointContextMusicConfig?.pageType ?? '';
  const videoId: string | null =
    item.playlistItemData?.videoId ?? watch?.videoId ?? null;
  const musicVideoType: string =
    watch?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig
      ?.musicVideoType ?? '';

  let kind: AgentSearchResult['kind'] = 'other';
  if (videoId)
    kind = musicVideoType === 'MUSIC_VIDEO_TYPE_ATV' ? 'song' : 'video';
  else if (pageType.includes('ALBUM')) kind = 'album';
  else if (pageType.includes('PLAYLIST')) kind = 'playlist';
  else if (pageType.includes('ARTIST')) kind = 'artist';

  const artists = detailRuns
    .filter(
      (r) =>
        r.navigationEndpoint?.browseEndpoint
          ?.browseEndpointContextSupportedConfigs
          ?.browseEndpointContextMusicConfig?.pageType ===
        'MUSIC_PAGE_TYPE_ARTIST',
    )
    .map((r) => r.text);

  let playlistId: string | null = watch?.playlistId ?? null;
  if (
    !playlistId &&
    typeof browse?.browseId === 'string' &&
    browse.browseId.startsWith('VL')
  )
    playlistId = browse.browseId.slice(2);

  return {
    kind,
    videoId,
    playlistId,
    browseId: browse?.browseId ?? null,
    title,
    artists,
    detail: runsText(detailRuns),
  };
}

// Collect every list row anywhere in the response. Walking the whole tree keeps working
// when YouTube Music moves shelves around, which it does often.
function collectListItems(node: any, out: any[], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) {
    for (const child of node) collectListItems(child, out, depth + 1);
    return;
  }
  if (node.musicResponsiveListItemRenderer) {
    out.push(node.musicResponsiveListItemRenderer);
    return;
  }
  for (const key of Object.keys(node))
    collectListItems(node[key], out, depth + 1);
}

async function search(
  query: string,
  filter: string,
  limit: number,
): Promise<AgentSearchResult[]> {
  if (!(filter in SEARCH_FILTERS))
    throw new Error(
      `unknown filter "${filter}", use one of ${Object.keys(SEARCH_FILTERS).join(', ')}`,
    );
  const params = SEARCH_FILTERS[filter];
  const data = await serviceRequest({
    searchEndpoint: params ? { query, params } : { query },
  });
  const rows: any[] = [];
  collectListItems(data?.contents ?? data, rows);
  const results: AgentSearchResult[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const parsed = parseListItem(row);
    if (!parsed) continue;
    const key = parsed.videoId ?? parsed.browseId ?? parsed.title;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push(parsed);
    if (results.length >= limit) break;
  }
  return results;
}

// ---- Playlists -----------------------------------------------------------------------
// Sent from the logged-in page with the page's own auth (SAPISIDHASH from its cookie,
// INNERTUBE_CONTEXT from ytcfg): the same request YouTube Music's "New playlist" dialog makes.

async function sha1Hex(text: string) {
  const digest = await crypto.subtle.digest(
    'SHA-1',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function readCookie(name: string): string | null {
  for (const part of document.cookie.split('; ')) {
    const eq = part.indexOf('=');
    if (part.slice(0, eq) === name)
      return decodeURIComponent(part.slice(eq + 1));
  }
  return null;
}

async function innertube(endpoint: string, body: object): Promise<any> {
  const ytcfg = (window as any).ytcfg;
  if (!ytcfg?.get) throw new Error('YouTube Music page not ready');
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Origin': location.origin,
    'X-Goog-AuthUser': String(ytcfg.get('SESSION_INDEX') ?? 0),
    'X-Youtube-Client-Name': String(
      ytcfg.get('INNERTUBE_CONTEXT_CLIENT_NAME') ?? 67,
    ),
    'X-Youtube-Client-Version': String(
      ytcfg.get('INNERTUBE_CLIENT_VERSION') ?? '',
    ),
  };
  const sapisid = readCookie('SAPISID') ?? readCookie('__Secure-3PAPISID');
  if (sapisid) {
    const ts = Math.floor(Date.now() / 1000);
    headers.Authorization = `SAPISIDHASH ${ts}_${await sha1Hex(`${ts} ${sapisid} ${location.origin}`)}`;
  }
  const response = await fetch(`/youtubei/v1/${endpoint}?prettyPrint=false`, {
    method: 'POST',
    credentials: 'include',
    headers,
    body: JSON.stringify({ context: ytcfg.get('INNERTUBE_CONTEXT'), ...body }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.error)
    throw new Error(
      data?.error?.message ?? `YouTube Music answered HTTP ${response.status}`,
    );
  return data;
}

const PRIVACY = ['PRIVATE', 'UNLISTED', 'PUBLIC'];

function videoIdList(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('videoIds must be a non-empty list');
  const ids = value.map(String).filter((id) => /^[A-Za-z0-9_-]{11}$/.test(id));
  if (ids.length !== value.length)
    throw new Error('every videoId must be an 11-character YouTube id');
  return [...new Set(ids)];
}

async function createPlaylist(
  title: string,
  description: string,
  privacy: string,
  videoIds: string[],
) {
  if (!title.trim()) throw new Error('a playlist needs a title');
  if (!PRIVACY.includes(privacy))
    throw new Error(`privacy must be one of ${PRIVACY.join(', ')}`);
  const data = await innertube('playlist/create', {
    title,
    description,
    privacyStatus: privacy,
    videoIds,
  });
  if (!data?.playlistId)
    throw new Error('YouTube Music did not return a playlist id');
  return { playlistId: data.playlistId as string, added: videoIds.length };
}

async function addToPlaylist(playlistId: string, videoIds: string[]) {
  const id = playlistId.startsWith('VL') ? playlistId.slice(2) : playlistId;
  const data = await innertube('browse/edit_playlist', {
    playlistId: id,
    actions: videoIds.map((addedVideoId) => ({
      action: 'ACTION_ADD_VIDEO',
      addedVideoId,
      dedupeOption: 'DEDUPE_OPTION_SKIP',
    })),
  });
  if (data?.status && data.status !== 'STATUS_SUCCEEDED')
    throw new Error(`YouTube Music answered ${data.status}`);
  return { playlistId: id, added: videoIds.length };
}

function collectTwoRowItems(node: any, out: any[], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return;
  if (Array.isArray(node)) {
    for (const child of node) collectTwoRowItems(child, out, depth + 1);
    return;
  }
  if (node.musicTwoRowItemRenderer) {
    out.push(node.musicTwoRowItemRenderer);
    return;
  }
  for (const key of Object.keys(node))
    collectTwoRowItems(node[key], out, depth + 1);
}

async function listPlaylists() {
  const data = await innertube('browse', {
    browseId: 'FEmusic_liked_playlists',
  });
  const items: any[] = [];
  collectTwoRowItems(data?.contents, items);
  return items
    .map((item) => {
      const browseId: string | undefined =
        item.navigationEndpoint?.browseEndpoint?.browseId;
      if (!browseId?.startsWith('VL')) return null; // the "New playlist" tile has no id
      return {
        playlistId: browseId.slice(2),
        title: runsText(item.title?.runs),
        detail: runsText(item.subtitle?.runs),
      };
    })
    .filter(Boolean);
}

export default function init() {
  const agentApi = protectedapimanager.createOrGetAPI('Agent');

  agentApi.handleMessage('search', async (event: any) => {
    const { query, filter = 'songs', limit = 10 } = event.detail.args[0] ?? {};
    try {
      return [
        {
          ok: true,
          result: await search(
            String(query ?? ''),
            String(filter),
            Math.max(1, Math.min(50, Number(limit) || 10)),
          ),
        },
      ];
    } catch (err) {
      return [{ ok: false, error: (err as Error)?.message ?? String(err) }];
    }
  });

  const handle = (name: string, run: (args: any) => Promise<unknown>) =>
    agentApi.handleMessage(name, async (event: any) => {
      try {
        return [{ ok: true, result: await run(event.detail.args[0] ?? {}) }];
      } catch (err) {
        return [{ ok: false, error: (err as Error)?.message ?? String(err) }];
      }
    });

  handle('createPlaylist', (a) =>
    createPlaylist(
      String(a.title ?? ''),
      String(a.description ?? ''),
      String(a.privacy ?? 'PRIVATE').toUpperCase(),
      videoIdList(a.videoIds),
    ),
  );
  handle('addToPlaylist', (a) =>
    addToPlaylist(String(a.playlistId ?? ''), videoIdList(a.videoIds)),
  );
  handle('playlists', () => listPlaylists());
}
