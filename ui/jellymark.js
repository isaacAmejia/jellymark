/*!
JellyMark — part of the JellyPi project.
Based on and adapted from KefinTweaks Watchlist by ranaldsgift.
Upstream: https://github.com/ranaldsgift/KefinTweaks
Adaptations include the standalone UI, theme integration, season history,
and integration with the optional JellyMark Sync service.

MIT License

Copyright (c) 2022 ranaldsgift
Copyright (c) 2026 JellyMark contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/
(() => {
    'use strict';

    const MODULE = '__JELLYFIN_WATCHLIST_SYNC_UI_V3__';
    if (window[MODULE]) return;
    window[MODULE] = true;

    const VERSION = '3.2.2';
    const P = 'jws3';
    const OVERLAY_ID = `${P}-overlay`;
    const STYLE_ID = `${P}-style`;
    const HOME_TAB_ID = `${P}-home-tab`;
    const SIDE_LINK_ID = `${P}-side-link`;
    const DETAIL_BUTTON = `${P}-detail-button`;
    const CARD_BUTTON = `${P}-card-button`;
    const SUPPORTED_TYPES = ['Movie', 'Series', 'Season', 'Episode', 'Video', 'BoxSet', 'Playlist'];
    const EXPORT_TYPES = ['Movie', 'Series', 'Season', 'Episode'];
    const CACHE_TTL = 5 * 60 * 1000;
    const CARD_REFRESH_MS = 30 * 1000;
    const PLAYLIST_CHUNK = 100;

    const state = {
        open: false,
        topTab: 'watchlist',
        typeFilter: 'All',
        layout: localStorage.getItem(`${P}:layout`) || 'grid',
        liked: new Map(),
        likedAt: 0,
        userId: null,
        busy: false,
        progress: null,
        progressAt: 0,
        history: null,
        historyAt: 0,
        stats: null,
        statsView: 'overview',
        targetCache: new Map(),
        observer: null,
        decorateTimer: 0,
        tabEnsureFrame: 0,
        lastFocus: null,
        playbackHooked: false,
        playbackSocket: null,
        playbackHandler: null,
        progressQuery: '',
        progressSort: 'last',
        progressFilter: 'all',
        historyQuery: '',
        historySort: 'last',
        historyFilter: 'all',
        historyType: 'All',
        hiddenPages: [],
        savedTabs: [],
        openedHash: null
    };

    const log = (...a) => console.log('[JellyMark]', ...a);
    const warn = (...a) => console.warn('[JellyMark]', ...a);

    function apiReady() {
        return !!(window.ApiClient && typeof ApiClient.getCurrentUserId === 'function');
    }

    function uid() {
        try { return ApiClient.getCurrentUserId(); } catch { return null; }
    }

    function serverAddress() {
        try { return String(ApiClient.serverAddress() || '').replace(/\/$/, ''); } catch { return ''; }
    }

    function authHeader() {
        let token = '';
        try { token = ApiClient.accessToken?.() || ''; } catch {}
        let device = 'Jellyfin Web';
        let deviceId = 'jellyfin-watchlist-sync-ui';
        try { device = ApiClient.deviceName?.() || device; } catch {}
        try { deviceId = ApiClient.deviceId?.() || deviceId; } catch {}
        const clean = v => String(v).replaceAll('"', '');
        return `MediaBrowser Client="JellyMark", Device="${clean(device)}", DeviceId="${clean(deviceId)}", Version="${VERSION}", Token="${clean(token)}"`;
    }

    async function request(path, { method = 'GET', params = {}, body = undefined } = {}) {
        if (method === 'GET' && path === '/Items' && Number(params.Limit) >= 10000) {
            const items = [], seen = new Set();
            let offset = 0;
            while (true) {
                const page = await request(path, { params: { ...params, StartIndex: offset, Limit: 500, EnableTotalRecordCount: true } });
                if (!Array.isArray(page?.Items)) throw new Error('Invalid item-list response');
                if (!page.Items.length) {
                    if (page.TotalRecordCount != null && offset < page.TotalRecordCount) throw new Error('Incomplete item-list response');
                    break;
                }
                for (const item of page.Items) {
                    if (!item.Id || seen.has(item.Id)) throw new Error('Duplicate/missing item during pagination');
                    seen.add(item.Id); items.push(item);
                }
                offset += page.Items.length;
                if (page.TotalRecordCount != null && offset >= page.TotalRecordCount) break;
            }
            return { Items: items, TotalRecordCount: items.length };
        }
        const base = serverAddress();
        if (!base) throw new Error('Jellyfin server address unavailable');
        const url = new URL(base + path, location.href);
        for (const [k, v] of Object.entries(params)) {
            if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
        }
        const options = {
            method,
            headers: { Accept: 'application/json', Authorization: authHeader() },
            credentials: 'same-origin'
        };
        if (body !== undefined) {
            options.headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }
        const res = await fetch(url, options);
        if (!res.ok) throw new Error(`${method} ${path} failed (${res.status})`);
        if (res.status === 204) return null;
        const text = await res.text();
        if (!text) return null;
        try { return JSON.parse(text); } catch { return text; }
    }

    function resetUserCachesIfNeeded() {
        const current = uid();
        if (state.userId === current) return;
        state.userId = current;
        state.liked.clear();
        state.likedAt = 0;
        state.progress = null;
        state.progressAt = 0;
        state.history = null;
        state.historyAt = 0;
        state.stats = null;
        state.targetCache.clear();
    }

    async function likedItems(force = false) {
        resetUserCachesIfNeeded();
        const user = uid();
        if (!user) return [];
        if (!force && state.likedAt && Date.now() - state.likedAt < CACHE_TTL) return [...state.liked.values()];
        const data = await request('/Items', { params: {
            UserId: user,
            Recursive: true,
            Filters: 'Likes',
            IncludeItemTypes: SUPPORTED_TYPES.join(','),
            Fields: 'ProviderIds,Path,ParentId,PrimaryImageAspectRatio,Overview',
            EnableUserData: true,
            EnableTotalRecordCount: false,
            SortBy: 'SortName',
            Limit: 10000
        }});
        if (uid() !== user) return [];
        state.liked = new Map((data?.Items || []).filter(x => x?.Id).map(x => [String(x.Id), x]));
        state.likedAt = Date.now();
        await normalizeEpisodeLikes();
        for (const item of [...state.liked.values()]) {
            if (uid() !== user) return [];
            if (EXPORT_TYPES.includes(item.Type) && item.UserData?.Played === true) await setLiked(item, false);
        }
        updateVisibleToggleStates();
        return [...state.liked.values()];
    }

    function isLiked(itemOrId) {
        resetUserCachesIfNeeded();
        const id = typeof itemOrId === 'string' ? itemOrId : itemOrId?.Id;
        return !!id && state.liked.has(String(id));
    }

    async function setLiked(item, desired, rerender = true) {
        const user = uid();
        if (!user || !item?.Id) return;
        if (typeof ApiClient.updateUserItemRating === 'function') {
            await ApiClient.updateUserItemRating(user, item.Id, desired ? 'true' : 'false');
        } else {
            await request(`/UserItems/${encodeURIComponent(item.Id)}/Rating`, {
                method: 'POST', params: { UserId: user, Likes: desired ? 'true' : 'false' }
            });
        }
        if (uid() !== user) return;
        if (desired) {
            item.UserData = { ...(item.UserData || {}), Likes: true };
            state.liked.set(String(item.Id), item);
        } else {
            state.liked.delete(String(item.Id));
        }
        state.likedAt = Date.now();
        updateVisibleToggleStates();
        if (rerender && state.open && state.topTab === 'watchlist') renderWatchlist();
    }

    async function seasonForEpisode(item) {
        const user = uid();
        const key = `episode:${item?.Id || ''}`;
        if (state.targetCache.has(key)) return state.targetCache.get(key);
        let season = null;
        const seasonId = item?.SeasonId || item?.ParentId;
        if (seasonId) {
            try {
                const candidate = await ApiClient.getItem(user, seasonId);
                if (candidate?.Type === 'Season') season = candidate;
            } catch {}
        }
        if (!season && item?.SeriesId && item?.ParentIndexNumber != null) {
            try {
                const data = await request('/Items', { params: {
                    UserId: user,
                    ParentId: item.SeriesId,
                    IncludeItemTypes: 'Season',
                    Fields: 'ProviderIds,Path,ParentId,PrimaryImageAspectRatio,Overview',
                    EnableUserData: true,
                    EnableTotalRecordCount: false,
                    Limit: 200
                }});
                season = (data?.Items || []).find(x => x.IndexNumber === item.ParentIndexNumber) || null;
            } catch {}
        }
        state.targetCache.set(key, season);
        return season;
    }

    async function watchlistTarget(item) {
        if (!item?.Id) return null;
        if (item.Type !== 'Episode') return item;
        return await seasonForEpisode(item);
    }

    async function canonicalLiked(item) {
        const target = await watchlistTarget(item);
        return !!target && isLiked(target);
    }

    async function normalizeEpisodeLikes() {
        const episodes = [...state.liked.values()].filter(x => x.Type === 'Episode');
        for (const episode of episodes) {
            const season = await seasonForEpisode(episode);
            if (!season) continue;
            if (!isLiked(season) && season.UserData?.Played !== true) await setLiked(season, true, false);
            if (isLiked(episode)) await setLiked(episode, false, false);
        }
    }

    async function toggleById(id, type, button) {
        if (!id || !SUPPORTED_TYPES.includes(type)) return;
        if (button) button.disabled = true;
        try {
            let item = state.liked.get(String(id));
            if (!item) item = await ApiClient.getItem(uid(), id);
            if (!item || !SUPPORTED_TYPES.includes(item.Type)) return;
            const target = await watchlistTarget(item);
            if (!target) return;
            const desired = !isLiked(target);
            await setLiked(target, desired, false);
            if (item.Type === 'Episode' && isLiked(item)) await setLiked(item, false, false);
            updateVisibleToggleStates();
            if (state.open && state.topTab === 'watchlist') renderWatchlist(false);
        } catch (e) { warn('Toggle failed', e); }
        finally { if (button?.isConnected) button.disabled = false; }
    }

    function installStyles() {
        if (document.getElementById(STYLE_ID)) return;
        const style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = `
/* Defaults follow the active theme. --jws-* properties are optional user overrides. */
#${OVERLAY_ID},.jws3-dialog,.jws3-toast {
 --jws-ink:var(--textColor,inherit);
 --jws-line:rgba(190,190,190,.22);
 --jws-surface:rgba(116,116,116,.12);
 --jws-glass:rgba(42,42,42,.50);
 --jws-radius:var(--largeRadius,1rem);
 color:var(--jws-ink);font-family:inherit;
}
#${OVERLAY_ID}{position:fixed;inset:var(--jws-header-bottom,7rem) 0 0;z-index:99;
 display:block;transform:none;max-width:none;width:auto;height:auto;max-height:none;margin:0;
 border:0;border-radius:0;box-shadow:none;overflow:auto;box-sizing:border-box;
 padding:1.25rem var(--sidePadding,4%) 4rem;
 background:var(--jws-page-background,var(--jws-sampled-background,transparent));
 color:var(--textColor,inherit);overscroll-behavior:contain;scrollbar-gutter:stable;
}
#${OVERLAY_ID}[hidden]{display:none!important}
.jws3-obscured{visibility:hidden!important;pointer-events:none!important}
.jws3-shell{max-width:100rem;margin:auto}
.jws3-head{position:relative;display:flex;justify-content:center;align-items:center;min-height:3rem;margin:0 0 1.75rem;gap:1rem}
.jws3-sr{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
.jws3-tabs,.jws3-chips{display:flex;justify-content:center;align-items:center;gap:.3rem;flex-wrap:wrap}
.jws3-tabs{padding:.25rem;border:1px solid var(--jws-line);border-radius:999px;background:var(--jws-surface);backdrop-filter:blur(24px) saturate(140%);-webkit-backdrop-filter:blur(24px) saturate(140%)}
.jws3-head>.btnClose{position:absolute;left:0}
#${OVERLAY_ID} :where(.jws3-btn,.jws3-chip,.jws3-tab){font:inherit;color:inherit;border:1px solid transparent;border-radius:999px;background:transparent;box-shadow:none;cursor:pointer;box-sizing:border-box;padding:.55rem 1rem;min-height:2.5rem;line-height:1.2;text-transform:none;letter-spacing:normal}
#${OVERLAY_ID} :where(.jws3-chip,.jws3-tab){opacity:.65;transition:background .15s,opacity .15s}
#${OVERLAY_ID} :where(.jws3-chip,.jws3-tab)[aria-pressed=true]{background:var(--jws-surface);border-color:var(--jws-line);opacity:1;font-weight:600}
#${OVERLAY_ID} :where(button:hover){opacity:1;background-color:var(--jws-surface)}
#${OVERLAY_ID} :where(button,.jws3-btn,.jws3-chip,.jws3-tab),.jws3-dialog :where(button,.jws3-btn){transform:none!important}
#${OVERLAY_ID} :where(button,input,select):focus,#${OVERLAY_ID} :where(button,input,select):focus-visible,.jws3-dialog :where(button,input,select,textarea):focus,.jws3-dialog :where(button,input,select,textarea):focus-visible{outline:none!important;transform:none!important}
.jws3-toolbar{display:flex;justify-content:space-between;align-items:center;gap:1rem;margin-bottom:1.5rem}
.jws3-toolbar>.jws3-chips{margin:auto}
.jws3-tools{display:flex;justify-content:center;align-items:center;flex-wrap:wrap;gap:.6rem;margin:0 0 1.5rem}
#${OVERLAY_ID} .jws3-tools :where(input,select){box-sizing:border-box;height:2.65rem;background:rgba(66,66,66,.72);border:1px solid var(--jws-line);border-radius:.72rem .72rem .95rem .95rem;padding:.5rem 1rem;color:#f2f2f2;font:inherit;max-width:100%;backdrop-filter:blur(32px) saturate(140%);-webkit-backdrop-filter:blur(32px) saturate(140%)}
#${OVERLAY_ID} select,.jws3-dialog select{color-scheme:dark;background-color:rgba(66,66,66,.92)!important;color:#f2f2f2!important;border-radius:.72rem .72rem .95rem .95rem!important}
#${OVERLAY_ID} select option,.jws3-dialog select option{background:#3b3b3b;color:#f2f2f2}
.jws3-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(clamp(8rem,13vw,12rem),1fr));gap:1.75rem 1.1rem}
.jws3-card{position:relative;min-width:0}
#${OVERLAY_ID} .jws3-card-open{display:block;width:100%;border:0;border-radius:var(--jws-radius);background:transparent;color:inherit;text-align:left;padding:0;font:inherit;cursor:pointer}
.jws3-poster{display:block;aspect-ratio:2/3;width:100%;border-radius:var(--jws-radius);background:var(--jws-surface) center/cover no-repeat;box-shadow:0 .4rem 1.3rem rgba(0,0,0,.16)}
.jws3-name{display:block;margin-top:.65rem;font-weight:550;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jws3-meta{display:block;opacity:.6;font-size:.82em;margin-top:.3rem;line-height:1.5;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#${OVERLAY_ID} .jws3-card-remove{position:absolute;right:.45rem;top:.45rem;display:grid;place-items:center;border:1px solid var(--jws-line);border-radius:.7rem;width:2.65rem;height:2.65rem;box-sizing:border-box;min-width:0;min-height:0;background:rgba(32,32,32,.75);color:var(--textColor,white);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);padding:.65rem;cursor:pointer}
.jws3-bookmark{display:block;width:1.35em;height:1.35em;pointer-events:none;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linejoin:round}
[aria-pressed=true]>.jws3-bookmark{fill:currentColor}
.${DETAIL_BUTTON},.${CARD_BUTTON}{display:inline-flex;align-items:center;justify-content:center}
.${DETAIL_BUTTON},.${CARD_BUTTON}{box-sizing:border-box!important;width:2.75rem!important;height:2.75rem!important;min-width:2.75rem!important;max-width:2.75rem!important;min-height:2.75rem!important;max-height:2.75rem!important;aspect-ratio:1;padding:.6rem!important;flex:0 0 auto}
.jws3-list{display:flex;flex-direction:column;gap:.8rem}
.jws3-list .jws3-card{padding:.65rem 4rem .65rem .65rem;border:1px solid var(--jws-line);border-radius:var(--jws-radius);background:var(--jws-surface)}
#${OVERLAY_ID} .jws3-list .jws3-card-open{display:grid;grid-template-columns:4rem 1fr;gap:1rem;align-items:center}
.jws3-empty,.jws3-loading,.jws3-error{padding:4rem 1rem;text-align:center;opacity:.65}
.jws3-progress-list{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr));gap:1rem}
.jws3-progress-row{display:grid;grid-template-columns:6rem minmax(0,1fr);gap:1.1rem;align-items:center;padding:1rem;border:1px solid var(--jws-line);border-radius:var(--jws-radius);background:var(--jws-surface);backdrop-filter:blur(30px) saturate(135%);-webkit-backdrop-filter:blur(30px) saturate(135%)}
.jws3-progress-info{min-width:0}.jws3-progress-info h3{margin:0 0 .6rem;font-size:1rem;font-weight:600}
.jws3-progress-info .jws3-btn{margin:.6rem 0 0;padding:.55rem .7rem;font-size:.8rem}
.jws3-bar{height:.3rem;border-radius:1rem;background:var(--jws-line);overflow:hidden;margin:.85rem 0 .45rem}
.jws3-bar>span{display:block;height:100%;border-radius:inherit;background:currentColor}
.jws3-summary{display:flex;flex-direction:column;max-width:38rem;margin:1.5rem auto;border:1px solid var(--jws-line);border-radius:var(--jws-radius);overflow:hidden;background:var(--jws-surface);backdrop-filter:blur(32px) saturate(140%);-webkit-backdrop-filter:blur(32px) saturate(140%)}
.jws3-stat{display:flex;align-items:center;justify-content:space-between;gap:2rem;padding:1rem 1.4rem;border-bottom:1px solid var(--jws-line)}
.jws3-stat:last-child{border-bottom:0}.jws3-stat strong{order:2;font-size:1.3rem;font-weight:550;font-variant-numeric:tabular-nums}.jws3-stat span{opacity:.7}
.jws3-dialog{position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,.35);display:grid;place-items:center;padding:1rem}
.jws3-dialog-card{width:min(34rem,90vw);max-height:82vh;overflow:auto;box-sizing:border-box;background:var(--jws-glass);color:#f2f2f2;border:1px solid var(--jws-line);border-radius:var(--jws-radius);padding:1.5rem;box-shadow:0 1rem 3rem rgba(0,0,0,.28);backdrop-filter:blur(40px) saturate(145%);-webkit-backdrop-filter:blur(40px) saturate(145%)}
.jws3-dialog-card h2{font-size:1.2rem;margin:0 0 1rem}.jws3-dialog-card :where(input,select,textarea){width:100%;box-sizing:border-box;margin:.4rem 0 1rem;padding:.75rem;background:rgba(66,66,66,.72);color:#f2f2f2;border:1px solid var(--jws-line);border-radius:.72rem .72rem .95rem .95rem;font:inherit}
.jws3-dialog-actions{display:flex;gap:.6rem;justify-content:flex-end;margin-top:1rem}
.jws3-dialog .jws3-btn{color:#f2f2f2;background:rgba(86,86,86,.28);border:1px solid var(--jws-line);border-radius:.72rem;padding:.65rem 1rem;font:inherit;cursor:pointer;transform:none!important}
.jws3-dialog .jws3-btn:hover,.jws3-dialog .jws3-btn:focus{background:rgba(118,118,118,.34)}
.jws3-menu{display:grid;gap:.55rem}.jws3-menu>.jws3-btn{text-align:left;border-radius:.72rem;background:rgba(78,78,78,.34);min-height:2.8rem}
.jws3-toast{position:fixed;right:1rem;bottom:1rem;z-index:10002;background:var(--jws-panel-background,rgba(32,32,32,.96));padding:1rem;border:1px solid var(--jws-line);border-radius:var(--jws-radius)}
#${OVERLAY_ID} button.emby-button:focus,.jws3-dialog button.emby-button:focus{background-color:var(--jws-surface);color:inherit;box-shadow:none;outline:none!important;transform:none!important}
button.${DETAIL_BUTTON}:focus,button.${CARD_BUTTON}:focus{background-color:rgba(128,128,128,.2);color:inherit;outline:none!important;transform:none!important}
.jws3-summary-heading{padding:1.4rem 1.4rem 1rem;margin:0;font-size:.85rem;letter-spacing:.08em;text-transform:uppercase;opacity:.65}
.jws3-summary-note{max-width:38rem;margin:.8rem auto;text-align:center;opacity:.55;font-size:.8rem;line-height:1.6}
.jws3-stat:first-of-type{padding-top:.7rem;padding-bottom:1.5rem}.jws3-stat:first-of-type strong{font-size:2rem}
.jws3-stats-nav{margin:0 auto 1.25rem}
.jws3-stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.8rem;margin:0 auto 1rem;max-width:70rem}
.jws3-stat-card,.jws3-viz-card{border:1px solid var(--jws-line);background:var(--jws-surface);border-radius:var(--jws-radius);backdrop-filter:blur(32px) saturate(140%);-webkit-backdrop-filter:blur(32px) saturate(140%)}
.jws3-stat-card{padding:1rem 1.1rem;min-height:5.6rem;display:flex;flex-direction:column;justify-content:space-between}
.jws3-stat-card strong{font-size:1.65rem;font-weight:550;font-variant-numeric:tabular-nums}.jws3-stat-card span{opacity:.66;font-size:.82rem}
.jws3-viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,20rem),1fr));gap:1rem;max-width:70rem;margin:0 auto}
.jws3-viz-card{padding:1.15rem}.jws3-viz-card h3{margin:0 0 1rem;font-size:.9rem;font-weight:600;opacity:.78}
.jws3-ring-wrap{display:flex;align-items:center;gap:1.2rem}.jws3-ring{--value:0;width:7rem;height:7rem;flex:0 0 7rem;border-radius:50%;display:grid;place-items:center;background:conic-gradient(currentColor calc(var(--value)*1%),rgba(128,128,128,.18) 0);position:relative}
.jws3-ring:after{content:"";position:absolute;inset:.65rem;border-radius:50%;background:rgba(42,42,42,.72)}
.jws3-ring strong{position:relative;z-index:1;font-size:1.15rem;font-weight:600}.jws3-ring-copy{min-width:0}.jws3-ring-copy strong{display:block;font-size:1.1rem;margin-bottom:.35rem}.jws3-ring-copy span{opacity:.62;font-size:.82rem;line-height:1.45}
.jws3-viz-row{display:grid;grid-template-columns:minmax(7rem,auto) 1fr auto;gap:.7rem;align-items:center;margin:.75rem 0;font-size:.82rem}.jws3-viz-row>span:first-child{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.jws3-viz-row>span:last-child{opacity:.65;font-variant-numeric:tabular-nums}
.jws3-viz-track{height:.45rem;border-radius:99px;background:rgba(128,128,128,.18);overflow:hidden}.jws3-viz-fill{height:100%;border-radius:inherit;background:currentColor;opacity:.82}
@media(max-width:650px){.jws3-head{padding-top:3rem}.jws3-head>.btnClose{top:0}.jws3-tab{font-size:.82rem!important;padding:.65rem .6rem!important}.jws3-toolbar{gap:.25rem}.jws3-toolbar .jws3-chips{flex-wrap:nowrap;gap:.15rem;min-width:0}.jws3-toolbar :where(.jws3-btn,.jws3-chip){padding:.6rem .6rem;font-size:.85rem}.jws3-toolbar>.jws3-btn{flex:0 0 2.4rem;padding:.6rem .15rem}.jws3-progress-row{grid-template-columns:4.5rem minmax(0,1fr);padding:.8rem}.jws3-stat{padding:1rem}.jws3-stat strong{font-size:1.4rem}}
@media(prefers-reduced-motion:reduce){#${OVERLAY_ID} *{transition:none!important;scroll-behavior:auto!important}}
`;
        document.head.appendChild(style);
    }

    function bookmarkIcon() {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 24 24');
        svg.setAttribute('aria-hidden', 'true');
        svg.classList.add('jws3-bookmark');
        const shape = document.createElementNS(svg.namespaceURI, 'path');
        shape.setAttribute('d', 'M6 3.5h12v17l-6-4-6 4z');
        svg.appendChild(shape);
        return svg;
    }

    function imageUrl(item, width = 420) {
        if (!item?.Id) return '';
        try {
            if (typeof ApiClient.getImageUrl === 'function') return ApiClient.getImageUrl(item.Id, { type: 'Primary', tag: item.ImageTags?.Primary, maxWidth: width, quality: 90 });
        } catch {}
        const u = new URL(`${serverAddress()}/Items/${encodeURIComponent(item.Id)}/Images/Primary`);
        u.searchParams.set('maxWidth', String(width));
        if (item.ImageTags?.Primary) u.searchParams.set('tag', item.ImageTags.Primary);
        return u.toString();
    }

    function meta(item) {
        if (item.Type === 'Episode') return `${item.SeriesName || 'Episode'} · S${String(item.ParentIndexNumber ?? '?').padStart(2,'0')}E${String(item.IndexNumber ?? '?').padStart(2,'0')}`;
        if (item.HistoryEpisodeCount) return `${item.Name || 'Season'} · ${item.HistoryEpisodeCount} episodes watched`;
        if (item.Type === 'Season') return `${item.SeriesName || 'Season'}${item.IndexNumber != null ? ` · Season ${item.IndexNumber}` : ''}`;
        return [item.Type === 'BoxSet' ? 'Collection' : item.Type, item.ProductionYear].filter(Boolean).join(' · ');
    }

    function openItem(item) {
        closeOverlay(false);
        try {
            if (window.Emby?.Page?.showItem) return Emby.Page.showItem(item.Id, item.ServerId || ApiClient.serverId?.());
        } catch {}
        const sid = item.ServerId || ApiClient.serverId?.();
        location.hash = `#/details?id=${encodeURIComponent(item.Id)}${sid ? `&serverId=${encodeURIComponent(sid)}` : ''}`;
    }

    function ensureOverlay() {
        let root = document.getElementById(OVERLAY_ID);
        if (root) return root;
        root = document.createElement('div');
        root.id = OVERLAY_ID;
        root.hidden = true;
        root.setAttribute('role', 'region');
        root.setAttribute('aria-label', 'Watchlist');
        document.body.appendChild(root);
        return root;
    }

    function headerShell(titleText) {
        const shell = document.createElement('div'); shell.className = 'jws3-shell';
        const head = document.createElement('div'); head.className = 'jws3-head';
        const title = document.createElement('h1'); title.className = 'jws3-sr'; title.textContent = titleText;
        const back = button('‹', () => closeOverlay(true), 'jws3-btn btnClose');
        back.title = 'Back to Jellyfin'; back.setAttribute('aria-label', 'Back to Jellyfin');
        const tabs = document.createElement('nav'); tabs.className = 'jws3-tabs'; tabs.setAttribute('aria-label','Watchlist sections');
        for (const [id, label] of [['watchlist','Watchlist'],['progress','Series Progress'],['history','Watch History'],['stats','Statistics']]) {
            const tab = button(label, () => { state.topTab = id; renderCurrent(false); }, 'jws3-tab');
            tab.dataset.section = id; tab.setAttribute('aria-pressed', String(state.topTab === id));
            tabs.appendChild(tab);
        }
        head.append(title, back, tabs); shell.appendChild(head);
        return shell;
    }

    function button(label, fn, cls = 'jws3-btn') {
        const b = document.createElement('button');
        b.type = 'button'; b.className = `${cls} emby-button`; b.textContent = label;
        if (fn) b.addEventListener('click', fn);
        return b;
    }

    function toast(message) {
        document.querySelector('.jws3-toast')?.remove();
        const t = document.createElement('div'); t.className = 'jws3-toast'; t.textContent = message; document.body.appendChild(t);
        setTimeout(() => t.remove(), 3200);
    }

    function setBusy(v) { state.busy = v; }

    async function renderCurrent(force = false) {
        if (!state.open) return;
        if (state.busy) return;
        if (state.topTab === 'watchlist') return renderWatchlist(force);
        if (state.topTab === 'progress') return renderProgress(force);
        if (state.topTab === 'history') return renderHistory(force);
        return renderStats(force);
    }

    async function renderWatchlist(force = false) {
        const root = ensureOverlay();
        root.replaceChildren(headerShell('Watchlist'));
        const shell = root.firstElementChild;
        shell.appendChild(loading('Loading Watchlist…'));
        try {
            const items = await likedItems(force);
            if (!state.open || state.topTab !== 'watchlist') return;
            shell.querySelector('.jws3-loading')?.remove();

            const displayItems = items.filter(x=>x.Type!=='Episode');
            const counts = { All:displayItems.length, Movie:displayItems.filter(x=>x.Type==='Movie').length, Shows:displayItems.filter(x=>x.Type==='Series'||x.Type==='Season').length };
            const chips = document.createElement('div'); chips.className = 'jws3-chips';
            const labels = [['All','All'],['Movie','Movies'],['Shows','Shows']];
            for (const [type,label] of labels) {
                const count = type === 'All' ? displayItems.length : counts[type] || 0;
                const b = button(label, () => { state.typeFilter = type; renderWatchlist(false); }, 'jws3-chip');
                b.setAttribute('aria-pressed', String(state.typeFilter === type)); b.setAttribute('aria-label', `${label}, ${count} items`); chips.appendChild(b);
            }
            const toolbar = document.createElement('div'); toolbar.className = 'jws3-toolbar';
            const refresh = button('↻', () => renderWatchlist(true)); refresh.setAttribute('aria-label','Refresh Watchlist');
            const more = button('···', watchlistMenu); more.setAttribute('aria-label','Watchlist tools');
            toolbar.append(refresh, chips, more); shell.appendChild(toolbar);

            let filtered = state.typeFilter === 'All' ? displayItems : displayItems.filter(x => state.typeFilter === 'Shows' ? (x.Type==='Series'||x.Type==='Season') : x.Type === state.typeFilter);
            if (!filtered.length) { shell.appendChild(empty('No items in this view.')); return; }
            const wrap = document.createElement('div'); wrap.className = state.layout === 'grid' ? 'jws3-grid' : 'jws3-list';
            for (const item of filtered) wrap.appendChild(makeCard(item, true));
            shell.appendChild(wrap);
            focusFirst(shell);
        } catch (e) { shell.querySelector('.jws3-loading')?.remove(); shell.appendChild(errorBox(e.message)); }
    }

    function makeCard(item, removable = false) {
        const wrap = document.createElement('div'); wrap.className = 'jws3-card';
        const open = document.createElement('button'); open.type = 'button'; open.className = 'jws3-card-open emby-button'; open.title = item.Name || 'Open item';
        const poster = document.createElement('span'); poster.className = 'jws3-poster'; const img = imageUrl(item); if (img) poster.style.backgroundImage = `url("${img.replace(/["\\\n\r]/g,'')}")`;
        const text = document.createElement('span'); const name = document.createElement('span'); name.className = 'jws3-name'; name.textContent = (item.HistoryEpisodeCount ? item.SeriesName : item.Name) || item.Name || 'Untitled'; const m = document.createElement('span'); m.className = 'jws3-meta'; m.textContent = meta(item); text.append(name,m);
        open.append(poster,text); open.addEventListener('click', () => openItem(item)); wrap.appendChild(open);
        if (removable) {
            const rm = button('', async () => { rm.disabled = true; try { await setLiked(item, false); } finally { rm.disabled = false; } }, 'jws3-card-remove'); rm.appendChild(bookmarkIcon()); rm.setAttribute('aria-pressed','true'); rm.title = 'Remove from Watchlist'; rm.setAttribute('aria-label', `Remove ${item.Name || 'item'} from Watchlist`); wrap.appendChild(rm);
        }
        return wrap;
    }

    function loading(text) { const d=document.createElement('div'); d.className='jws3-loading'; d.textContent=text; return d; }
    function empty(text) { const d=document.createElement('div'); d.className='jws3-empty'; d.textContent=text; return d; }
    function errorBox(text) { const d=document.createElement('div'); d.className='jws3-error'; d.textContent=`Could not load: ${text}`; return d; }
    function focusFirst(scope) { if (!state.open && scope.closest('#'+OVERLAY_ID)) return; const f=scope.querySelector('.jws3-tab[aria-pressed="true"]') || scope.querySelector('button:not([disabled]),[tabindex="0"]'); if(f instanceof HTMLElement) try{f.focus({preventScroll:true});}catch{} }

    async function loadProgress(force = false) {
        resetUserCachesIfNeeded();
        if (!force && state.progress && Date.now()-state.progressAt<CACHE_TTL) return state.progress;
        const user=uid();
        const [seriesData,episodeData]=await Promise.all([
            request('/Items',{params:{UserId:user,Recursive:true,IncludeItemTypes:'Series',Fields: '',EnableUserData:true,EnableTotalRecordCount:false,Limit:10000}}),
            request('/Items',{params:{UserId:user,Recursive:true,IncludeItemTypes:'Episode',Fields: '',EnableUserData:true,EnableTotalRecordCount:false,Limit:100000}})
        ]);
        const seriesMap=new Map((seriesData?.Items||[]).map(x=>[String(x.Id),x]));
        const groups=new Map();
        for(const ep of episodeData?.Items||[]){ if(!ep.SeriesId) continue; const k=String(ep.SeriesId); if(!groups.has(k))groups.set(k,[]); groups.get(k).push(ep); }
        const out=[];
        for(const [id,eps] of groups){ const watched=eps.filter(e=>e.UserData?.Played); if(!watched.length)continue; const series=seriesMap.get(id)||{Id:id,Name:eps[0]?.SeriesName||'Series'}; const total=eps.length; const watchedCount=watched.length; const last=watched.map(e=>e.UserData?.LastPlayedDate).filter(Boolean).sort().at(-1)||null; const runtime=eps.reduce((a,e)=>a+(e.RunTimeTicks||0),0); const watchedRuntime=watched.reduce((a,e)=>a+(e.RunTimeTicks||0),0); out.push({series,episodes:eps,total,watched:watchedCount,remaining:total-watchedCount,percent:total?Math.round(watchedCount*100/total):0,last,runtime,watchedRuntime}); }
        out.sort((a,b)=>String(b.last||'').localeCompare(String(a.last||'')));
        if(uid()!==user)return []; state.progress=out; state.progressAt=Date.now(); return out;
    }

    function progressControls(shell, rows) {
        const tools=document.createElement('div');tools.className='jws3-tools';
        const q=document.createElement('input');q.className='jws3-btn';q.placeholder='Filter series…';q.value=state.progressQuery;q.setAttribute('aria-label','Filter series');
        const filter=document.createElement('select');filter.className='jws3-btn';for(const [v,l] of [['all','All started'],['active','In progress'],['complete','Completed']]){const o=document.createElement('option');o.value=v;o.textContent=l;filter.appendChild(o);}filter.value=state.progressFilter;
        const sort=document.createElement('select');sort.className='jws3-btn';for(const [v,l] of [['last','Last watched'],['title','Title'],['percent','Completion'],['remaining','Remaining']]){const o=document.createElement('option');o.value=v;o.textContent=l;sort.appendChild(o);}sort.value=state.progressSort;
        const redraw=()=>renderProgressRows(shell,rows);q.addEventListener('input',()=>{state.progressQuery=q.value;redraw();});filter.addEventListener('change',()=>{state.progressFilter=filter.value;redraw();});sort.addEventListener('change',()=>{state.progressSort=sort.value;redraw();});
        tools.append(q,filter,sort,button('Refresh',()=>renderProgress(true)));shell.appendChild(tools);
    }
    function renderProgressRows(shell, rows){shell.querySelector('.jws3-progress-list')?.remove();shell.querySelector('.jws3-empty[data-view="progress"]')?.remove();let view=rows.filter(r=>!state.progressQuery||String(r.series.Name||'').toLowerCase().includes(state.progressQuery.toLowerCase()));if(state.progressFilter==='active')view=view.filter(r=>r.remaining>0);if(state.progressFilter==='complete')view=view.filter(r=>r.remaining===0);view=[...view].sort((a,b)=>{if(state.progressSort==='title')return String(a.series.Name||'').localeCompare(String(b.series.Name||''));if(state.progressSort==='percent')return b.percent-a.percent;if(state.progressSort==='remaining')return a.remaining-b.remaining;return String(b.last||'').localeCompare(String(a.last||''));});if(!view.length){const e=empty('No series match this view.');e.dataset.view='progress';shell.appendChild(e);return;}const list=document.createElement('div');list.className='jws3-progress-list';for(const r of view){
            const row=document.createElement('article');row.className='jws3-progress-row';
            const poster=makeCard(r.series,false);poster.querySelector('.jws3-card-open>span:last-child')?.remove();
            const info=document.createElement('div');info.className='jws3-progress-info';
            const name=document.createElement('h3');name.textContent=r.series.Name;
            const count=document.createElement('span');count.className='jws3-meta';count.textContent=`${r.watched} of ${r.total} episodes watched`;
            const bar=document.createElement('div');bar.className='jws3-bar';bar.setAttribute('role','progressbar');bar.setAttribute('aria-label',r.series.Name+' progress');bar.setAttribute('aria-valuenow',r.percent);bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');
            const fill=document.createElement('span');fill.style.width=`${r.percent}%`;bar.appendChild(fill);
            const remaining=document.createElement('span');remaining.className='jws3-meta';remaining.textContent=`${r.percent}% complete · ${r.remaining} remaining`;
            info.append(name,count,bar,remaining,button(r.remaining?'Mark watched':'Mark unplayed',()=>markSeriesEpisodes(r,r.remaining>0)));
            row.append(poster,info);list.appendChild(row);
        }shell.appendChild(list);}
    async function renderProgress(force=false){
        const root=ensureOverlay(); root.replaceChildren(headerShell('Series Progress')); const shell=root.firstElementChild; shell.appendChild(loading('Calculating series progress…'));
        try{const rows=await loadProgress(force); if(!state.open||state.topTab!=='progress')return; shell.querySelector('.jws3-loading')?.remove();progressControls(shell,rows);renderProgressRows(shell,rows);focusFirst(shell);}catch(e){shell.querySelector('.jws3-loading')?.remove();shell.appendChild(errorBox(e.message));}
    }

    async function markPlayed(id, played){ await request(`/UserPlayedItems/${encodeURIComponent(id)}`,{method:played?'POST':'DELETE',params:{UserId:uid()}}); }
    async function markSeriesEpisodes(row,played){ if(state.busy)return;setBusy(true);try{const targets=row.episodes.filter(e=>Boolean(e.UserData?.Played)!==played);for(let i=0;i<targets.length;i+=20){await Promise.allSettled(targets.slice(i,i+20).map(e=>markPlayed(e.Id,played)));}state.progress=null;state.history=null;state.stats=null;await renderProgress(true);toast(`${row.series.Name}: ${played?'marked watched':'marked unplayed'}`);}finally{setBusy(false);} }

    async function loadHistory(force=false){
        resetUserCachesIfNeeded();
        if(!force&&state.history&&Date.now()-state.historyAt<CACHE_TTL)return state.history;
        const user=uid();
        const params={UserId:user,Recursive:true,Fields:'ProviderIds,ParentId',EnableUserData:true,EnableTotalRecordCount:false,Limit:100000};
        const [data,seasons]=await Promise.all([
            request('/Items',{params:{...params,IncludeItemTypes:'Movie,Episode',Filters:'IsPlayed'}}),
            request('/Items',{params:{...params,IncludeItemTypes:'Season'}})
        ]);
        const byId=new Map((seasons?.Items||[]).map(s=>[String(s.Id),s]));
        const byNumber=new Map();
        for(const season of seasons?.Items||[]){
            if(!season.SeriesId||season.IndexNumber==null)continue;
            const key=`${season.SeriesId}:${season.IndexNumber}`;
            byNumber.set(key,byNumber.has(key)?null:season);
        }
        const watched=(data?.Items||[]).filter(x=>x.UserData?.Played);
        const out=watched.filter(x=>x.Type==='Movie'),groups=new Map();
        for(const ep of watched.filter(x=>x.Type==='Episode')){
            const season=byId.get(String(ep.SeasonId||ep.ParentId))||byNumber.get(`${ep.SeriesId}:${ep.ParentIndexNumber}`);
            // Never use an episode ID or screenshot as a season substitute.
            if(!season)continue;
            if(!groups.has(season.Id))groups.set(season.Id,{season,episodes:[]});
            groups.get(season.Id).episodes.push(ep);
        }
        for(const {season,episodes} of groups.values()){
            out.push({...season,Type:'Season',SeriesName:season.SeriesName||episodes[0].SeriesName,
                HistoryEpisodeCount:episodes.length,
                RunTimeTicks:episodes.reduce((sum,ep)=>sum+(ep.RunTimeTicks||0),0),
                UserData:{...season.UserData,
                    LastPlayedDate:episodes.map(ep=>ep.UserData?.LastPlayedDate||'').sort().at(-1),
                    PlayCount:Math.max(...episodes.map(ep=>ep.UserData?.PlayCount||1))}});
        }
        out.sort((a,b)=>String(b.UserData?.LastPlayedDate||'').localeCompare(String(a.UserData?.LastPlayedDate||'')));
        if(uid()!==user)return [];
        state.history=out;state.historyAt=Date.now();return out;
    }

    async function setFavorite(item,desired){await request(`/UserFavoriteItems/${encodeURIComponent(item.Id)}`,{method:desired?'POST':'DELETE',params:{UserId:uid()}});item.UserData={...(item.UserData||{}),IsFavorite:desired};}
    function historyControls(shell, items){const tools=document.createElement('div');tools.className='jws3-tools';const q=document.createElement('input');q.className='jws3-btn';q.placeholder='Search watch history…';q.value=state.historyQuery;q.setAttribute('aria-label','Search watch history');const filter=document.createElement('select');filter.className='jws3-btn';for(const[v,l]of[['all','All watched'],['favorite','Favorites'],['repeat','Watched more than once']]){const o=document.createElement('option');o.value=v;o.textContent=l;filter.appendChild(o);}filter.value=state.historyFilter;const sort=document.createElement('select');sort.className='jws3-btn';for(const[v,l]of[['last','Last watched'],['title','Title'],['year','Release year'],['plays','Play count'],['runtime','Runtime']]){const o=document.createElement('option');o.value=v;o.textContent=l;sort.appendChild(o);}sort.value=state.historySort;const types=document.createElement('div');types.className='jws3-chips';for(const [value,label] of [['All','All'],['Movie','Movies'],['Season','Seasons']]){const choice=button(label,()=>{state.historyType=value;renderHistory(false)},'jws3-chip');choice.setAttribute('aria-pressed',String(state.historyType===value));types.appendChild(choice)}shell.appendChild(types);const redraw=()=>renderHistoryRows(shell,items);q.addEventListener('input',()=>{state.historyQuery=q.value;redraw();});filter.addEventListener('change',()=>{state.historyFilter=filter.value;redraw();});sort.addEventListener('change',()=>{state.historySort=sort.value;redraw();});tools.append(q,filter,sort,button('Refresh',()=>renderHistory(true)));shell.appendChild(tools);}
    function renderHistoryRows(shell,items){shell.querySelector('.jws3-history-grid')?.remove();shell.querySelector('.jws3-empty[data-view="history"]')?.remove();let view=items.filter(x=>(state.historyType==='All'||x.Type===state.historyType)&&(!state.historyQuery||`${x.Name||''} ${x.SeriesName||''}`.toLowerCase().includes(state.historyQuery.toLowerCase())));if(state.historyFilter==='favorite')view=view.filter(x=>x.UserData?.IsFavorite);if(state.historyFilter==='repeat')view=view.filter(x=>(x.UserData?.PlayCount||0)>1);view=[...view].sort((a,b)=>{if(state.historySort==='title')return `${a.SeriesName||''} ${a.Name||''}`.localeCompare(`${b.SeriesName||''} ${b.Name||''}`);if(state.historySort==='year')return (b.ProductionYear||0)-(a.ProductionYear||0);if(state.historySort==='plays')return (b.UserData?.PlayCount||0)-(a.UserData?.PlayCount||0);if(state.historySort==='runtime')return (b.RunTimeTicks||0)-(a.RunTimeTicks||0);return String(b.UserData?.LastPlayedDate||'').localeCompare(String(a.UserData?.LastPlayedDate||''));});if(!view.length){const e=empty('No watched items match this view.');e.dataset.view='history';shell.appendChild(e);return;}const wrap=document.createElement('div');wrap.className='jws3-grid jws3-history-grid';for(const item of view){const c=makeCard(item,false);const fav=button(item.UserData?.IsFavorite?'★':'☆',async()=>{fav.disabled=true;try{await setFavorite(item,!item.UserData?.IsFavorite);fav.textContent=item.UserData?.IsFavorite?'★':'☆';fav.title=item.UserData?.IsFavorite?'Remove favorite':'Add favorite';}finally{fav.disabled=false;}},'jws3-card-remove');fav.title=item.UserData?.IsFavorite?'Remove favorite':'Add favorite';c.appendChild(fav);wrap.appendChild(c);}shell.appendChild(wrap);}
    async function renderHistory(force=false){const root=ensureOverlay();root.replaceChildren(headerShell('Watch History'));const shell=root.firstElementChild;shell.appendChild(loading('Loading watch history…'));try{const items=await loadHistory(force);if(!state.open||state.topTab!=='history')return;shell.querySelector('.jws3-loading')?.remove();historyControls(shell,items);renderHistoryRows(shell,items);focusFirst(shell);}catch(e){shell.querySelector('.jws3-loading')?.remove();shell.appendChild(errorBox(e.message));}}

    function statsControls(shell){
        const nav=document.createElement('div');nav.className='jws3-chips jws3-stats-nav';
        for(const [value,label] of [['overview','Overview'],['watchlist','Watchlist'],['progress','Progress']]){
            const b=button(label,()=>{state.statsView=value;renderStats(false)},'jws3-chip');
            b.setAttribute('aria-pressed',String(state.statsView===value));nav.appendChild(b);
        }
        shell.appendChild(nav);
    }
    function metricCard(label,value){
        const d=document.createElement('div');d.className='jws3-stat-card';
        const strong=document.createElement('strong');strong.textContent=String(value);
        const span=document.createElement('span');span.textContent=label;d.append(strong,span);return d;
    }
    function barViz(title,rows){
        const card=document.createElement('section');card.className='jws3-viz-card';
        const h=document.createElement('h3');h.textContent=title;card.appendChild(h);
        const max=Math.max(1,...rows.map(r=>Number(r[1])||0));
        for(const [label,value] of rows){
            const row=document.createElement('div');row.className='jws3-viz-row';
            const name=document.createElement('span');name.textContent=label;
            const track=document.createElement('div');track.className='jws3-viz-track';
            const fill=document.createElement('div');fill.className='jws3-viz-fill';fill.style.width=`${Math.max(2,Math.round((Number(value)||0)*100/max))}%`;track.appendChild(fill);
            const count=document.createElement('span');count.textContent=String(value);row.append(name,track,count);card.appendChild(row);
        }
        return card;
    }
    function ringViz(title,pct,headline,detail){
        const card=document.createElement('section');card.className='jws3-viz-card';
        const h=document.createElement('h3');h.textContent=title;
        const wrap=document.createElement('div');wrap.className='jws3-ring-wrap';
        const ring=document.createElement('div');ring.className='jws3-ring';ring.style.setProperty('--value',String(Math.max(0,Math.min(100,pct))));
        const value=document.createElement('strong');value.textContent=`${Math.round(pct)}%`;ring.appendChild(value);
        const copy=document.createElement('div');copy.className='jws3-ring-copy';const strong=document.createElement('strong');strong.textContent=headline;const span=document.createElement('span');span.textContent=detail;copy.append(strong,span);
        wrap.append(ring,copy);card.append(h,wrap);return card;
    }
    async function renderStats(force=false){
        const root=ensureOverlay();root.replaceChildren(headerShell('Statistics'));const shell=root.firstElementChild;shell.appendChild(loading('Calculating statistics…'));
        try{
            const [history,progress]=await Promise.all([loadHistory(force),loadProgress(force)]);const liked=(await likedItems(force)).filter(x=>x.Type!=='Episode');
            if(!state.open||state.topTab!=='stats')return;
            shell.querySelector('.jws3-loading')?.remove();statsControls(shell);
            const watchedEpisodes=progress.reduce((a,r)=>a+r.watched,0);
            const totalEpisodes=progress.reduce((a,r)=>a+r.total,0);
            const remainingEpisodes=progress.reduce((a,r)=>a+r.remaining,0);
            const completedSeries=progress.filter(r=>r.remaining===0).length;
            const activeSeries=progress.filter(r=>r.remaining>0).length;
            const movies=history.filter(x=>x.Type==='Movie');
            const seasons=history.filter(x=>x.Type==='Season');
            const movieTicks=movies.reduce((a,m)=>a+(m.RunTimeTicks||0),0);
            const epTicks=progress.reduce((a,r)=>a+r.watchedRuntime,0);
            const completion=totalEpisodes?watchedEpisodes*100/totalEpisodes:0;
            const metrics=document.createElement('div');metrics.className='jws3-stat-grid';
            const visuals=document.createElement('div');visuals.className='jws3-viz-grid';
            if(state.statsView==='watchlist'){
                const movieLikes=liked.filter(x=>x.Type==='Movie').length;
                const seriesLikes=liked.filter(x=>x.Type==='Series').length;
                const seasonLikes=liked.filter(x=>x.Type==='Season').length;
                const otherLikes=liked.length-movieLikes-seriesLikes-seasonLikes;
                for(const [label,value] of [['Watchlist total',liked.length],['Movies',movieLikes],['Series',seriesLikes],['Seasons',seasonLikes],['Other',otherLikes]])metrics.appendChild(metricCard(label,value));
                visuals.append(
                    barViz('Watchlist composition',[['Movies',movieLikes],['Series',seriesLikes],['Seasons',seasonLikes],['Other',otherLikes]]),
                    ringViz('Show entries',liked.length?(seriesLikes+seasonLikes)*100/liked.length:0,`${seriesLikes+seasonLikes} show entries`,'Series stay series; episode bookmarks roll up to seasons.')
                );
            }else if(state.statsView==='progress'){
                const avg=progress.length?progress.reduce((a,r)=>a+r.percent,0)/progress.length:0;
                for(const [label,value] of [['Series started',progress.length],['In progress',activeSeries],['Completed',completedSeries],['Episodes remaining',remainingEpisodes],['Average completion',`${Math.round(avg)}%`]])metrics.appendChild(metricCard(label,value));
                const top=[...progress].sort((a,b)=>b.percent-a.percent||a.remaining-b.remaining).slice(0,6);
                visuals.append(
                    ringViz('Overall episode progress',completion,`${watchedEpisodes} of ${totalEpisodes}`,'Across series with at least one watched episode.'),
                    barViz('Most complete series',top.map(r=>[r.series.Name,r.percent]))
                );
            }else{
                for(const [label,value] of [['Watch time',formatTicks(movieTicks+epTicks)],['Movies watched',movies.length],['Seasons started',seasons.length],['Episodes watched',watchedEpisodes],['Series completed',completedSeries],['On your watchlist',liked.length]])metrics.appendChild(metricCard(label,value));
                visuals.append(
                    ringViz('Episode completion',completion,`${watchedEpisodes} watched`,`${remainingEpisodes} episodes remaining across started series.`),
                    barViz('Viewing mix',[['Movies',movies.length],['Seasons',seasons.length],['Series completed',completedSeries]])
                );
            }
            shell.append(metrics,visuals);
            const note=document.createElement('p');note.className='jws3-summary-note';note.textContent='Statistics use current Jellyfin user data. Watch time counts each currently watched movie or episode once.';shell.appendChild(note);focusFirst(shell);
        }catch(e){shell.querySelector('.jws3-loading')?.remove();shell.appendChild(errorBox(e.message));}
    }
    function formatTicks(t){const m=Math.floor((t||0)/10000000/60),h=Math.floor(m/60);return h?`${h.toLocaleString()} h ${m%60} min`:`${m} min`;}

    async function exportWatchlist(){try{const items=(await likedItems(true)).filter(x=>EXPORT_TYPES.includes(x.Type));const out=[];for(const item of items){const p=item.ProviderIds||{};if(!p.Imdb&&!p.Tmdb&&!p.Tvdb)continue;const e={status:true,Name:item.Name,Type:item.Type};if(p.Imdb)e.Imdb=p.Imdb;if(p.Tmdb)e.Tmdb=p.Tmdb;if(p.Tvdb)e.Tvdb=p.Tvdb;if(item.Type==='Episode'&&item.SeriesName)e.SeriesName=item.SeriesName;if(item.Type==='Season'&&item.SeriesName)e.SeriesName=item.SeriesName;if(item.Type==='Episode'&&item.ParentId){try{const season=await request(`/Items/${encodeURIComponent(item.ParentId)}`,{params:{UserId:uid(),Fields: ''}});if(season?.Name)e.SeasonName=season.Name;}catch{}}out.push(e);}const blob=new Blob([JSON.stringify(out,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`jellyfin-watchlist-${new Date().toISOString().slice(0,10)}.json`;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},1000);toast(`Exported ${out.length} items`);}catch(e){toast(`Export failed: ${e.message}`);}}

    function importDialog(){const content=document.createElement('div');const ta=document.createElement('textarea');ta.rows=12;ta.placeholder='Paste KefinTweaks-compatible Watchlist JSON here';content.appendChild(ta);showDialog('Import Watchlist',content,[['Cancel',null],['Import',async close=>{let data;try{data=JSON.parse(ta.value);}catch{toast('Invalid JSON');return;}const v=validateImport(data);if(v){toast(v);return;}close();await importWatchlist(data);}]]);}
    function validateImport(data){if(!Array.isArray(data)||!data.length)return 'Import must be a non-empty JSON array.';for(let i=0;i<data.length;i++){const x=data[i];const type=x?.Type||x?.type;if(!EXPORT_TYPES.includes(type))return `Item ${i+1}: invalid Type.`;if(!(x.Imdb||x.imdb||x.Tmdb||x.tmdb||x.Tvdb||x.tvdb))return `Item ${i+1}: missing provider ID.`;if(x.status!==undefined&&typeof x.status!=='boolean')return `Item ${i+1}: status must be boolean.`;}return null;}
    async function importWatchlist(data){setBusy(true);try{const types=[...new Set(data.map(x=>x.Type||x.type))];const lib=await request('/Items',{params:{UserId:uid(),Recursive:true,IncludeItemTypes:types.join(','),Fields: 'ProviderIds',EnableUserData:true,EnableTotalRecordCount:false,Limit:100000}});const map=new Map();for(const item of lib?.Items||[]){const p=item.ProviderIds||{};for(const k of ['Imdb','Tmdb','Tvdb'])if(p[k]){const key=`${k}:${p[k]}:${item.Type}`;map.set(key,map.has(key)?null:item);}}let changed=0,missing=0;for(const src of data){const type=src.Type||src.type;const keys=[src.Imdb||src.imdb?`Imdb:${src.Imdb||src.imdb}:${type}`:null,src.Tmdb||src.tmdb?`Tmdb:${src.Tmdb||src.tmdb}:${type}`:null,src.Tvdb||src.tvdb?`Tvdb:${src.Tvdb||src.tvdb}:${type}`:null].filter(Boolean);const matches=keys.map(k=>map.get(k)).filter(Boolean);const item=keys.some(k=>map.has(k)&&map.get(k)===null)||new Set(matches.map(x=>x.Id)).size!==1?null:matches[0];if(!item){missing++;continue;}const desired=src.status!==false;const current=isLiked(item)||item.UserData?.Likes===true;if(current!==desired){await setLiked(item,desired);changed++;}}await likedItems(true);toast(`Import complete: ${changed} changed, ${missing} not found`);if(state.open)renderWatchlist(false);}catch(e){toast(`Import failed: ${e.message}`);}finally{setBusy(false);}}

    function showDialog(titleText,content,actions){
        const previous=document.activeElement;
        const layer=document.createElement('div');layer.className='jws3-dialog';layer.setAttribute('role','dialog');layer.setAttribute('aria-modal','true');layer.setAttribute('aria-label',titleText);
        const card=document.createElement('div');card.className='jws3-dialog-card';
        const h=document.createElement('h2');h.textContent=titleText;
        const footer=document.createElement('div');footer.className='jws3-dialog-actions';
        const close=()=>{layer.remove();previous?.isConnected&&previous.focus({preventScroll:true});};
        layer.jwsClose=close;
        for(const [label,fn] of actions){const b=button(label,()=>fn?fn(close):close());if(!fn)b.classList.add('btnClose');footer.appendChild(b);}
        card.append(h,content,footer);layer.appendChild(card);document.body.appendChild(layer);focusFirst(card);
    }

    function watchlistMenu(){
        const content=document.createElement('div');content.className='jws3-menu';
        const choose=fn=>()=>{document.querySelector('.jws3-dialog')?.jwsClose?.();fn();};
        for(const [label,fn] of [[state.layout==='grid'?'List view':'Poster view',()=>{state.layout=state.layout==='grid'?'list':'grid';localStorage.setItem(`${P}:layout`,state.layout);renderWatchlist(false)}],['Import Watchlist',importDialog],['Export Watchlist',exportWatchlist],['Sync to playlist',playlistDialog]])content.appendChild(button(label,choose(fn)));
        showDialog('Watchlist tools',content,[['Close',null]]);
    }

    async function playlistDialog(){try{const data=await request('/Items',{params:{UserId:uid(),Recursive:true,IncludeItemTypes:'Playlist',Fields: '',EnableTotalRecordCount:false,Limit:10000}});const playlists=data?.Items||[];const content=document.createElement('div');const select=document.createElement('select');const n=document.createElement('option');n.value='__new__';n.textContent='Create new playlist';select.appendChild(n);for(const p of playlists){const o=document.createElement('option');o.value=p.Id;o.textContent=p.Name;select.appendChild(o);}const input=document.createElement('input');input.placeholder='New playlist name';input.value='Watchlist';content.append(select,input);showDialog('Sync Watchlist to Playlist',content,[['Cancel',null],['Sync',async close=>{close();try{await syncPlaylist(select.value,input.value.trim(),playlists);toast('Playlist synced');}catch(e){toast(`Playlist sync failed: ${e.message}`);}}]]);}catch(e){toast(`Could not load playlists: ${e.message}`);}}
    function buildPlaylistSyncItems(items){const series=new Set(items.filter(x=>x.Type==='Series').map(x=>String(x.Id)));const seasons=new Set(items.filter(x=>x.Type==='Season').map(x=>String(x.Id)));const seen=new Set();return items.filter(item=>{if(!item?.Id||seen.has(String(item.Id)))return false;if(item.Type==='Episode'&&((item.ParentId&&seasons.has(String(item.ParentId)))||(item.SeasonId&&seasons.has(String(item.SeasonId)))||(item.SeriesId&&series.has(String(item.SeriesId)))))return false;seen.add(String(item.Id));return ['Movie','Series','Season','Episode'].includes(item.Type);});}
    async function syncPlaylist(choice,newName,playlists){const items=buildPlaylistSyncItems(await likedItems(true));if(!items.length)throw new Error('No eligible Watchlist items');const ids=items.map(x=>x.Id);let playlistId=choice;if(choice==='__new__'){if(!newName)throw new Error('Playlist name required');const p=await request('/Playlists',{method:'POST',params:{Name:newName,UserId:uid()}});playlistId=p?.Id;if(!playlistId)throw new Error('No playlist ID returned');}else{const existing=await request(`/Playlists/${encodeURIComponent(playlistId)}/Items`);const entries=(existing?.Items||[]).map(x=>x.PlaylistItemId).filter(Boolean);for(let i=0;i<entries.length;i+=PLAYLIST_CHUNK)await request(`/Playlists/${encodeURIComponent(playlistId)}/Items`,{method:'DELETE',params:{EntryIds:entries.slice(i,i+PLAYLIST_CHUNK).join(',')}});}for(let i=0;i<ids.length;i+=PLAYLIST_CHUNK)await request(`/Playlists/${encodeURIComponent(playlistId)}/Items`,{method:'POST',params:{Ids:ids.slice(i,i+PLAYLIST_CHUNK).join(',')}});}

    function updateThemeAndBounds(){
        const root=ensureOverlay();
        const headers=[...document.querySelectorAll('.skinHeader,.headerTabs')].filter(visible);
        const bottom=Math.max(0,...headers.map(x=>x.getBoundingClientRect().bottom));
        root.style.setProperty('--jws-header-bottom', `${Math.min(bottom,innerHeight*.45)}px`);
        const surfaces=[document.querySelector('.backgroundContainer:not(.backgroundContainer-transparent)'),document.documentElement,document.body].filter(Boolean);
        const computed=surfaces.map(el=>getComputedStyle(el)).find(s=>s.backgroundColor!=='rgba(0, 0, 0, 0)'||s.backgroundImage!=='none');
        if(computed)root.style.setProperty('--jws-sampled-background',`${computed.backgroundImage} ${computed.backgroundColor}`);
    }

    function openOverlay(){
        if(state.open)return;
        state.lastFocus=document.activeElement;state.openedHash=location.hash;
        const root=ensureOverlay();updateThemeAndBounds();
        state.savedTabs=[...document.querySelectorAll('.headerTabs .emby-tab-button,.skinHeader .emby-tab-button')].filter(x=>x.id!==HOME_TAB_ID).map(el=>({el,active:el.classList.contains('emby-tab-button-active'),selected:el.getAttribute('aria-selected')}));
        for(const {el} of state.savedTabs){el.classList.remove('emby-tab-button-active');el.setAttribute('aria-selected','false');}
        state.hiddenPages=[...document.querySelectorAll('.page,.homePage,#homePage')].filter(el=>visible(el)&&!el.contains(root)&&!el.closest('.skinHeader')).map(el=>({el,inert:el.inert}));
        for(const {el} of state.hiddenPages){el.classList.add('jws3-obscured');el.inert=true;}
        root.hidden=false;state.open=true;
        document.documentElement.classList.add(`${P}-open`);syncHomeTabState();renderCurrent(false);
    }
    function closeOverlay(restore=true){
        if(!state.open)return;
        document.querySelectorAll('.jws3-dialog').forEach(x=>x.jwsClose?.());
        const root=ensureOverlay();root.hidden=true;state.open=false;
        for(const {el,inert} of state.hiddenPages){el.classList.remove('jws3-obscured');el.inert=inert;}
        state.hiddenPages=[];
        for(const {el,active,selected} of state.savedTabs){if(!el.isConnected)continue;el.classList.toggle('emby-tab-button-active',active);if(selected===null)el.removeAttribute('aria-selected');else el.setAttribute('aria-selected',selected);}
        state.savedTabs=[];document.documentElement.classList.remove(`${P}-open`);syncHomeTabState();
        if(restore&&state.lastFocus?.isConnected)state.lastFocus.focus({preventScroll:true});
    }
    function visible(el){if(!(el instanceof Element))return false;const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0;}
    function homeVisible(){return [...document.querySelectorAll('.homePage,#homePage,#indexPage')].some(visible);}
    function findTabHost(){for(const selector of ['.skinHeader .headerTabs','.headerTabs','.skinHeader .emby-tabs']){const c=[...document.querySelectorAll(selector)].filter(visible);const shell=c.find(x=>x.querySelector('.emby-tab-button'))||c[0];if(shell)return shell.querySelector('.emby-tabs-slider')||shell;}return null;}
    function syncHomeTabState(){const tab=document.getElementById(HOME_TAB_ID);if(!tab)return;tab.classList.toggle('emby-tab-button-active',state.open);tab.setAttribute('aria-selected',String(state.open));}
    function ensureHomeTab(){
        if(!apiReady()||!uid()){document.getElementById(HOME_TAB_ID)?.remove();return;}
        const host=findTabHost();
        if(!host)return;

        let tab=document.getElementById(HOME_TAB_ID);
        const native=[...host.querySelectorAll('.emby-tab-button')].filter(x=>x!==tab);
        const favorites=native.find(x=>x.dataset.index==='1')||native[1]||native[0];

        if(!tab){
            if(favorites){
                tab=favorites.cloneNode(true);
                tab.classList.remove('emby-tab-button-active');
                tab.removeAttribute('data-index');
                tab.removeAttribute('aria-controls');
                tab.removeAttribute('href');
                tab.removeAttribute('style');
                tab.textContent='Watchlist';
            }else{
                tab=document.createElement('button');
                tab.type='button';
                tab.className='emby-tab-button emby-button';
                tab.textContent='Watchlist';
            }

            tab.id=HOME_TAB_ID;
            tab.setAttribute('aria-label','Watchlist');
            tab.setAttribute('role','tab');
            tab.setAttribute('aria-selected','false');
            tab.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();openOverlay();});
        }

        /*
         * Treat Watchlist like a persistent native tab. Jellyfin can rebuild
         * the header/tab slider on route changes; move the same tab node into
         * the current live host instead of removing/recreating it.
         */
        if(tab.parentElement!==host){
            if(favorites)favorites.after(tab);
            else host.appendChild(tab);
        }else if(favorites&&favorites.nextElementSibling!==tab){
            favorites.after(tab);
        }

        syncHomeTabState();
    }

    function ensureSideLink(){if(!apiReady()||!uid())return;if(document.getElementById(SIDE_LINK_ID))return;const menus=[...document.querySelectorAll('.mainDrawer-scrollContainer,.mainDrawer .scrollContainer')];const host=menus.find(visible)||menus[0];if(!host)return;const a=button('Watchlist',()=>openOverlay(),'navMenuOption emby-button');a.id=SIDE_LINK_ID;a.style.width='100%';a.style.textAlign='left';host.appendChild(a);}

    function currentDetailPage(){return [...document.querySelectorAll('.itemDetailPage')].find(visible)||null;}
    function currentItemId(){const p=currentDetailPage();if(!p)return null;try{const hash=location.hash||'';const q=hash.includes('?')?hash.slice(hash.indexOf('?')+1):'';return new URLSearchParams(q).get('id')||p.dataset?.id||null;}catch{return p.dataset?.id||null;}}
    async function ensureDetailButton(){
        if(!apiReady()||!uid()||state.open)return;
        const page=currentDetailPage(),host=page?.querySelector('.mainDetailButtons'),id=currentItemId();if(!host||!id)return;
        let b=host.querySelector(`.${DETAIL_BUTTON}`);if(b&&b.dataset.itemId===id){refreshToggleButton(b);return;}b?.remove();
        let item;try{item=await ApiClient.getItem(uid(),id);}catch{return;}
        if(currentItemId()!==id||!SUPPORTED_TYPES.includes(item?.Type)||host.querySelector(`.${DETAIL_BUTTON}`))return;
        b=button('',()=>toggleById(id,item.Type,b),`${DETAIL_BUTTON} detailButton paper-icon-button-light button-flat`);
        b.dataset.itemId=id;b.dataset.itemType=item.Type;b.appendChild(bookmarkIcon());setToggleState(b,false);host.appendChild(b);refreshToggleButton(b);
    }
    function setToggleState(b,liked){b.dataset.active=String(liked);b.title=liked?'Remove from Watchlist':'Add to Watchlist';b.setAttribute('aria-label',b.title);b.setAttribute('aria-pressed',String(liked));}
    async function refreshToggleButton(b){
        if(!b?.isConnected||!b.dataset.itemId)return;
        try{
            let item=state.liked.get(String(b.dataset.itemId));
            if(!item)item=await ApiClient.getItem(uid(),b.dataset.itemId);
            if(!item||!b.isConnected)return;
            setToggleState(b,await canonicalLiked(item));
        }catch{}
    }
    function decorateCards(){if(!apiReady()||!uid())return;document.querySelectorAll('.cardOverlayContainer').forEach(overlay=>{const card=overlay.closest('.card');if(!card)return;const id=card.getAttribute('data-id'),type=card.getAttribute('data-type');if(!id||!SUPPORTED_TYPES.includes(type))return;const host=overlay.querySelector('.cardOverlayButton-br');if(!host||host.querySelector(`.${CARD_BUTTON}`))return;const b=document.createElement('button');b.type='button';b.className=`${CARD_BUTTON} cardOverlayButton cardOverlayButton-hover paper-icon-button-light emby-button button-flat`;b.dataset.itemId=id;b.dataset.itemType=type;b.appendChild(bookmarkIcon());setToggleState(b,false);b.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();toggleById(id,type,b);});host.appendChild(b);refreshToggleButton(b);});}
    function updateVisibleToggleStates(){document.querySelectorAll(`.${DETAIL_BUTTON},.${CARD_BUTTON}`).forEach(b=>refreshToggleButton(b));}

    function scheduleTabEnsure(){
        if(state.tabEnsureFrame)return;
        state.tabEnsureFrame=requestAnimationFrame(()=>{
            state.tabEnsureFrame=0;
            try{ensureHomeTab();}catch(e){warn('Tab maintenance failed',e);}
        });
    }
    function scheduleDecorate(){scheduleTabEnsure();clearTimeout(state.decorateTimer);state.decorateTimer=setTimeout(async()=>{try{ensureHomeTab();ensureSideLink();await ensureDetailButton();decorateCards();}catch(e){warn('Decoration pass failed',e);}},150);}
    function escapeHandler(e){
        if(!['Escape','BrowserBack','GoBack'].includes(e.key))return;
        const dialog=document.querySelector('.jws3-dialog');
        if(!state.open&&!dialog)return;

        /*
         * With JellyNav installed, JellyMark guards the browser default but
         * deliberately leaves propagation alone so JellyNav can own the Back
         * hierarchy regardless of which script registered its listener first.
         */
        if(window.__JELLYFIN_TV_REMOTE__?.watchlistKeyOwnership){
            e.preventDefault();
            return;
        }

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if(dialog)dialog.jwsClose?.();else closeOverlay(true);
    }
    function escapeKeyupGuard(e){
        if(!['Escape','BrowserBack','GoBack'].includes(e.key))return;
        if(!window.__JELLYFIN_TV_REMOTE__?.watchlistKeyOwnership)return;
        if(!state.open&&!document.querySelector('.jws3-dialog'))return;
        e.preventDefault();
    }

    function hookUserDataEvents(){const socket=window.ApiClient?.webSocket||window.ApiClient?._webSocket;if(!socket||typeof socket.addEventListener!=='function')return;if(state.playbackSocket===socket&&state.playbackHooked)return;if(state.playbackSocket&&state.playbackHandler&&typeof state.playbackSocket.removeEventListener==='function'){try{state.playbackSocket.removeEventListener('message',state.playbackHandler);}catch{}}const handler=event=>{try{const raw=event?.Data||event?.data;const data=typeof raw==='string'?JSON.parse(raw):raw;if(data?.MessageType==='UserDataChanged'){for(const ud of data.Data?.UserDataList||[]){if(ud.ItemId&&ud.Played&&ud.Likes)autoRemovePlayed(ud.ItemId);}}}catch{}};socket.addEventListener('message',handler);state.playbackSocket=socket;state.playbackHandler=handler;state.playbackHooked=true;}
    async function autoRemovePlayed(id){try{let item=state.liked.get(String(id));if(!item)item=await ApiClient.getItem(uid(),id);if(item&&EXPORT_TYPES.includes(item.Type)&&item.UserData?.Played===true)await setLiked(item,false);}catch(e){warn('Auto-remove failed',e);}}

    window.__JELLYMARK__={
        version:VERSION,
        isOpen:()=>state.open,
        open:()=>openOverlay(),
        close:(restore=true)=>closeOverlay(restore),
        ensureTab:()=>ensureHomeTab(),
        getTab:()=>document.getElementById(HOME_TAB_ID),
        getOverlay:()=>document.getElementById(OVERLAY_ID),
        getSection:()=>state.topTab
    };

    async function init(){installStyles();ensureOverlay();window.addEventListener('keydown',escapeHandler,true);window.addEventListener('keyup',escapeKeyupGuard,true);state.observer=new MutationObserver(()=>{scheduleTabEnsure();scheduleDecorate();});state.observer.observe(document.documentElement,{childList:true,subtree:true});window.addEventListener('hashchange',()=>{ensureHomeTab();if(state.open&&location.hash!==state.openedHash)closeOverlay(false);scheduleDecorate()});window.addEventListener('resize',()=>{if(state.open)updateThemeAndBounds()});document.addEventListener('click',event=>{
    if(!state.open)return;
    const target=event.target instanceof Element?event.target:null;
    if(!target)return;
    if(target.closest('#'+OVERLAY_ID)||target.closest('.jws3-dialog')||target.closest('#'+HOME_TAB_ID))return;
    closeOverlay(false);
},true);document.addEventListener('viewshow',()=>{ensureHomeTab();scheduleDecorate();},true);for(let i=0;i<120&&!apiReady();i++)await new Promise(r=>setTimeout(r,250));if(!apiReady()){warn('ApiClient unavailable');return;}try{await likedItems(true);}catch(e){warn('Initial Watchlist fetch failed',e);}scheduleDecorate();hookUserDataEvents();setInterval(()=>{if(uid())likedItems(true).catch(()=>{});hookUserDataEvents();},CARD_REFRESH_MS);log(`Loaded v${VERSION}`);}
    init();
})();


