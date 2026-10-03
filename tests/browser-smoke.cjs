// Optional: npm install --no-save playwright && npx playwright install chromium
// --ui-only requires no backend. --admin-only requires JWS_TEST_URL (default localhost:18788).
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const path = require('node:path');
(async () => {
  const browser = await chromium.launch({headless: true, args: ['--no-sandbox']});
  try {
    if (!process.argv.includes('--ui-only')) {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    const base = process.env.JWS_TEST_URL || 'http://127.0.0.1:18788';
    // Simulate LAN HTTP where crypto.randomUUID is unavailable.
    await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', {value: undefined}));
    await page.goto(base);
    await page.locator('#token').fill(process.env.JWS_TEST_TOKEN || 'smoke-test');
    await page.getByRole('button', {name: 'Unlock', exact: true}).click();
    await page.locator('#app').waitFor({state: 'visible'});
    await page.getByRole('button', {name: 'Add pair', exact: true}).click();
    assert.equal(await page.locator('.pair').count(), 1);
    assert.match(await page.locator('.pair').getAttribute('data-id'), /^pair-[0-9a-f]{32}$/);
    await page.getByRole('button', {name: 'Sync now', exact: true}).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.includes('Configure both'));
    assert.deepEqual(errors, []);
    console.log('PASS: admin HTTP pair creation, auth, sync status, no JavaScript errors');

    await page.close();
    }
    if (!process.argv.includes('--admin-only')) {
    // A minimal Jellyfin DOM + API fixture exercises the injected script itself.
    const ui = await browser.newPage();
    const uiErrors = [];
    ui.on('pageerror', e => uiErrors.push(e.message));
    const forbiddenRequests = [];
    // Only the current Jellyfin server is reachable; no companion or Kefin runtime.
    await ui.route('**/*', route => {
      forbiddenRequests.push(route.request().url());
      return route.abort();
    });
    let liked = true;
    const watchedMovie={Id:'history-movie',Name:'Watched Movie',Type:'Movie',RunTimeTicks:36000000000,UserData:{Played:true,PlayCount:2,IsFavorite:true}};
    const watchedEpisode={Id:'history-episode',Name:'Pilot',SeriesId:'series1',SeasonId:'season1',SeriesName:'Test Series',Type:'Episode',ParentIndexNumber:1,IndexNumber:1,RunTimeTicks:18000000000,UserData:{Played:true,PlayCount:1}};
    const secondWatchedEpisode={...watchedEpisode,Id:'watched-ep2',IndexNumber:2,UserData:{Played:true,PlayCount:3}};
    const season={Id:'season1',Name:'Season 1',Type:'Season',SeriesId:'series1',SeriesName:'Test Series',IndexNumber:1,ImageTags:{Primary:'season-poster'},UserData:{IsFavorite:false}};
    const show={Id:'series1',Name:'Test Series',Type:'Series'};
    const writes = [];
    const item = () => ({Id:'movie1',Name:'Test Movie',Type:'Movie',ProductionYear:2024,
      ProviderIds:{Tmdb:'123'},UserData:{Likes:liked,Played:false}});
    await ui.route('http://jellyfin.test/**', async route => {
      const url = new URL(route.request().url());
      if (url.pathname === '/') return route.fulfill({contentType:'text/html',body:`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>
:root{--textColor:rgb(220,225,235);--activeColor:rgb(119,91,244);--selectorBackgroundColorAlpha:rgba(55,65,81,.5);--lighterBorderColor:rgba(255,255,255,.2);--backgroundGradient:linear-gradient(135deg,#090d30,#18283b);--headerColor:rgba(30,40,54,.8);--largeRadius:1em;--sidePadding:4%}
body{margin:0;color:var(--textColor);font:16px system-ui;background:var(--backgroundGradient);min-height:100vh}.skinHeader{height:90px;background:var(--headerColor);position:fixed;top:0;width:100%;z-index:1000;display:flex;align-items:center;justify-content:center}.headerTabs{display:flex;gap:20px}.emby-tab-button{background:none;border:0;color:inherit;font:inherit;padding:12px}.emby-tab-button-active{border-bottom:2px solid currentColor}.homePage{padding-top:110px}.card{width:120px;height:160px}
html,.backgroundContainer:not(.withBackdrop):not(.backgroundContainer-transparent){background-color:#202020!important;background-image:none!important}
.emby-button.show-focus:focus,.emby-tabs .emby-button.show-focus:focus{background-color:rgb(37,99,235)!important;color:#fff!important}
.emby-tab-button:hover{background-color:#f2f2f2!important;color:#000!important}
.detailButton{padding:1em 2em;min-width:6em}
</style><div class="backgroundContainer"></div><header class="skinHeader"><div class="headerTabs"><button data-index="0" class="emby-tab-button emby-tab-button-active" aria-selected="true">Home</button><button data-index="1" class="emby-tab-button" style="display:none">Favorites</button><button data-index="2" class="emby-tab-button">Discover</button></div></header><div class="homePage">Home content</div><div class="mainDrawer-scrollContainer"></div><div class="card" data-id="movie1" data-type="Movie"><div class="cardOverlayContainer"><div class="cardOverlayButton-br"></div></div></div>`});
      if (url.pathname.endsWith('/Rating')) {
        liked = url.searchParams.get('Likes') === 'true'; writes.push(liked);
        return route.fulfill({json:item().UserData});
      }
      if (url.pathname === '/Items/movie1') return route.fulfill({json:item()});
      if (url.pathname === '/Items') {
        const types=url.searchParams.get('IncludeItemTypes');
        if(url.searchParams.get('Filters')==='IsPlayed')return route.fulfill({json:{Items:[watchedMovie,watchedEpisode,secondWatchedEpisode],TotalRecordCount:3}});
        if(types==='Season')return route.fulfill({json:{Items:[season],TotalRecordCount:1}});
        if(types==='Series')return route.fulfill({json:{Items:[show],TotalRecordCount:1}});
        if(types==='Episode')return route.fulfill({json:{Items:[watchedEpisode,secondWatchedEpisode,{...watchedEpisode,Id:'ep3',IndexNumber:2,UserData:{Played:false}}],TotalRecordCount:3}});
        const entries = url.searchParams.get('Filters') === 'Likes' && liked ? [item()] : [];
        return route.fulfill({json:{Items:entries,TotalRecordCount:entries.length}});
      }
      if(url.pathname.includes('/Images/'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450"><rect width="300" height="450" fill="#26374a"/><circle cx="180" cy="160" r="100" fill="#566681"/><path d="M0 400L210 120 300 450z" fill="#182739"/></svg>'});
      return route.fulfill({status:404,body:'not found'});
    });
    await ui.goto('http://jellyfin.test/');
    await ui.addInitScript(() => {
      window.ApiClient = {getCurrentUserId:()=> 'user1',serverAddress:()=>location.origin,
        accessToken:()=> 'fake', getItem: async()=> ({Id:'movie1',Name:'Test Movie',Type:'Movie',UserData:{Played:false}})};
    });
    await ui.reload();
    await ui.addScriptTag({path:path.join(__dirname,'../ui/jellymark.js')});
    await ui.locator('#jws3-home-tab').waitFor();
    await ui.locator('#jws3-home-tab').click();
    await ui.getByText('Test Movie', {exact:true}).waitFor();
    assert.deepEqual(await ui.locator('.headerTabs>.emby-tab-button').allTextContents(), ['Home','Favorites','Watchlist','Discover']);
    assert.equal(await ui.locator('.headerTabs [data-index="1"]').isVisible(), false);
    assert.deepEqual(await ui.locator('.jws3-chips button').allTextContents(), ['All','Movies','Shows']);
    const headerBounds=await ui.locator('.skinHeader').boundingBox(),panelBounds=await ui.locator('#jws3-overlay').boundingBox();
    assert.ok(panelBounds.y>=headerBounds.y+headerBounds.height);
    assert.equal(await ui.locator('#jws3-home-tab').getAttribute('aria-selected'),'true');
    assert.equal(await ui.locator('#jws3-overlay').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(32, 32, 32)');
    assert.equal(await ui.locator('#jws3-overlay').evaluate(el=>getComputedStyle(el).backgroundImage),'none');
    await ui.mouse.move(0,0);
    await ui.locator('#jws3-home-tab').focus();
    // The tab inherits the native active-tab styling instead of forcing a custom pill.
    await ui.addStyleTag({content:'.headerTabs .emby-tab-button-active{background:rgb(60,60,60)}'});
    assert.equal(await ui.locator('#jws3-home-tab').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(60, 60, 60)');
    await ui.locator('.jws3-tab').first().focus();
    assert.equal(await ui.locator('.jws3-tab').first().evaluate(el=>getComputedStyle(el).outlineStyle),'none');
    for(const selector of ['.jws3-card-remove','.jws3-card-button']){
      const box=await ui.locator(selector).first().boundingBox();assert.ok(Math.abs(box.width-box.height)<1);
    }
    assert.ok(await ui.locator('.jws3-tabs').evaluate(el=>parseFloat(getComputedStyle(el).borderRadius)>=el.getBoundingClientRect().height/2));
    const fs=require('node:fs');fs.mkdirSync('test-results',{recursive:true});
    await ui.screenshot({path:'test-results/watchlist-desktop.png'});
    await ui.getByRole('button',{name:'Series Progress',exact:true}).click();
    await ui.locator('.jws3-progress-row .jws3-poster').waitFor();
    assert.equal(await ui.getByRole('progressbar').getAttribute('aria-valuenow'),'67');
    await ui.screenshot({path:'test-results/progress-desktop.png'});
    await ui.getByRole('button',{name:'Watch History',exact:true}).click();
    await ui.getByText('Watched Movie',{exact:true}).waitFor();
    await ui.locator('.jws3-history-grid').getByText('Test Series',{exact:true}).waitFor();
    await ui.getByRole('button',{name:'Seasons',exact:true}).click();
    await ui.locator('.jws3-history-grid').getByText('Test Series',{exact:true}).waitFor();
    assert.equal(await ui.getByText('Watched Movie',{exact:true}).count(),0);
    await ui.getByLabel('Search watch history').fill('Test Series');
    assert.equal(await ui.locator('.jws3-history-grid .jws3-card').count(),1);
    assert.match(await ui.locator('.jws3-history-grid .jws3-poster').getAttribute('style'), /Items\/season1\/Images\/Primary/);
    assert.equal(await ui.getByText('Pilot',{exact:true}).count(),0);
    await ui.locator('.jws3-tools select').first().selectOption('repeat');
    assert.equal(await ui.locator('.jws3-history-grid .jws3-card').count(),1);
    await ui.locator('.jws3-tools select').first().selectOption('favorite');
    assert.equal(await ui.locator('.jws3-history-grid .jws3-card').count(),0);
    await ui.locator('.jws3-tools select').first().selectOption('all');
    await ui.screenshot({path:'test-results/history-desktop.png'});
    await ui.getByRole('button',{name:'Statistics',exact:true}).click();
    await ui.locator('.jws3-stat-card').first().waitFor();
    assert.equal(await ui.locator('.jws3-stat-card').count(),6);
    assert.equal(await ui.locator('.jws3-stat-card').filter({hasText:'Episodes watched'}).locator('strong').textContent(),'2');
    await ui.locator('.jws3-stats-nav').getByRole('button',{name:'Watchlist',exact:true}).click();
    await ui.getByText('Watchlist total',{exact:true}).waitFor();
    assert.equal(await ui.locator('.jws3-stat-card').filter({hasText:'Watchlist total'}).locator('strong').textContent(),'1');
    await ui.locator('.jws3-stats-nav').getByRole('button',{name:'Progress',exact:true}).click();
    await ui.getByText('Episodes remaining',{exact:true}).waitFor();
    assert.equal(await ui.locator('.jws3-stat-card').filter({hasText:'Episodes remaining'}).locator('strong').textContent(),'1');
    await ui.locator('.jws3-stats-nav').getByRole('button',{name:'Overview',exact:true}).click();
    await ui.getByText('Episodes watched',{exact:true}).waitFor();
    await ui.screenshot({path:'test-results/statistics-desktop.png'});
    await ui.locator('.headerTabs [data-index="0"]').click();
    assert.equal(await ui.locator('#jws3-overlay').isVisible(),false);
    assert.equal(await ui.locator('#jws3-home-tab').getAttribute('aria-selected'),'false');
    assert.equal(await ui.locator('#jws3-home-tab').evaluate(el=>el.classList.contains('emby-tab-button-active')),false);
    await ui.locator('#jws3-home-tab').click();
    await ui.locator('.jws3-tabs').getByRole('button',{name:'Watchlist',exact:true}).click();
    await ui.getByText('Test Movie',{exact:true}).waitFor();
    await ui.setViewportSize({width:390,height:844});
    const chipRows=await ui.locator('.jws3-toolbar .jws3-chip').evaluateAll(es=>es.map(e=>e.getBoundingClientRect().top));
    assert.ok(chipRows.every(y=>Math.abs(y-chipRows[0])<1));
    await ui.screenshot({path:'test-results/watchlist-mobile.png'});
    assert.ok(await ui.locator('#jws3-overlay').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
    await ui.setViewportSize({width:1280,height:720});

    await ui.keyboard.press('Escape');
    await ui.locator('.jws3-card-button').click();
    await ui.waitForFunction(() => document.querySelector('.jws3-card-button').dataset.active === 'false');
    assert.deepEqual(writes, [false]);
    await ui.locator('.jws3-card-button').click();
    await ui.waitForFunction(() => document.querySelector('.jws3-card-button').dataset.active === 'true');
    assert.deepEqual(writes, [false, true]);
    await ui.reload();
    await ui.addScriptTag({path:path.join(__dirname,'../ui/jellymark.js')});
    await ui.locator('#jws3-home-tab').click();
    await ui.getByText('Test Movie', {exact:true}).waitFor();
    await ui.keyboard.press('Escape');
    // Repeated decoration must settle rather than triggering an observer loop.
    const mutations = await ui.evaluate(async () => {
      let n=0; const obs=new MutationObserver(()=>n++);
      obs.observe(document.querySelector('.jws3-card-button'),{childList:true,subtree:true});
      await new Promise(r=>setTimeout(r,650));obs.disconnect();return n;
    });
    assert.equal(mutations,0);
    // An external navigation script may own semantics, but JellyMark must still
    // consume Back at the browser boundary so Chromium/Jellyfin history cannot
    // navigate underneath the open Watchlist.
    await ui.locator('#jws3-home-tab').click();
    await ui.evaluate(()=>{window.__JELLYFIN_TV_REMOTE__={watchlistKeyOwnership:true};});
    const ownership=await ui.evaluate(()=>{
      const result={};
      for(const key of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter','Escape','BrowserBack','GoBack']){
        const event=new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true});
        window.dispatchEvent(event);result[key]=event.defaultPrevented;
      }
      return result;
    });
    for(const key of ['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Enter']) assert.equal(ownership[key],false);
    for(const key of ['Escape','BrowserBack','GoBack']) assert.equal(ownership[key],true);
    assert.equal(await ui.locator('#jws3-overlay').isVisible(),true);
    assert.equal(await ui.locator('#jws3-overlay.actionSheet').count(),0);

    // Jellyfin may replace the tab host on SPA navigation. JellyMark should
    // move the same Watchlist tab node into the new live header in one frame.
    const persistent=await ui.evaluate(async()=>{
      const original=document.getElementById('jws3-home-tab');
      original.dataset.persistenceProbe='same-node';
      const old=document.querySelector('.headerTabs');
      const replacement=old.cloneNode(true);
      replacement.querySelector('#jws3-home-tab')?.remove();
      old.replaceWith(replacement);
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
      const current=document.getElementById('jws3-home-tab');
      return {
        same:current===original,
        probe:current?.dataset.persistenceProbe||null,
        visible:!!current&&getComputedStyle(current).display!=='none'
      };
    });
    assert.equal(persistent.same,true);
    assert.equal(persistent.probe,'same-node');
    assert.equal(persistent.visible,true);
    await ui.evaluate(()=>{delete window.__JELLYFIN_TV_REMOTE__;});
    await ui.keyboard.press('Escape');
    assert.equal(await ui.locator('#jws3-overlay').isVisible(),false);
    // Account/dashboard controls can close the overlay without a route change.
    await ui.evaluate(()=>{
      const b=document.createElement('button');b.id='test-account';b.textContent='Account';
      document.querySelector('.skinHeader').appendChild(b);
    });
    await ui.locator('#jws3-home-tab').click();
    await ui.locator('#test-account').click();
    assert.equal(await ui.locator('#jws3-overlay').isVisible(),false);
    await ui.evaluate(()=>{
      const detail=document.createElement('div');detail.className='itemDetailPage';detail.dataset.id='movie1';
      detail.style.cssText='position:fixed;top:200px;left:200px;width:200px;height:100px';
      detail.innerHTML='<div class="mainDetailButtons"></div>';document.body.appendChild(detail);
    });
    await ui.locator('.jws3-detail-button').waitFor();
    const detailBox=await ui.locator('.jws3-detail-button').boundingBox();
    assert.ok(Math.abs(detailBox.width-detailBox.height)<1);
    // Background sampling must follow a later CSS change, not cached blue variables.
    await ui.addStyleTag({content:'html,.backgroundContainer:not(.withBackdrop):not(.backgroundContainer-transparent){background-color:#eeeeee!important;background-image:none!important}'});
    assert.equal(await ui.locator('.backgroundContainer').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(238, 238, 238)');
    await ui.locator('#jws3-home-tab').click();
    assert.equal(await ui.locator('#jws3-overlay').evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(238, 238, 238)');
    assert.deepEqual(uiErrors, []);
    assert.deepEqual(forbiddenRequests, []);
    console.log('PASS: standalone theme UI, header/tab restoration, bookmarks, progress, movie/season history filters, statistics views and external navigation ownership, responsive layout, persistence');
    }
  } finally { await browser.close(); }
})().catch(e => { console.error(e); process.exitCode=1; });


