/* ============================================================
   RADIO OACV — moteur d'antenne v3
   Architecture à canaux unifiés : musique (YT), pub YouTube (YT),
   PubOACV (fichier), jingle (fichier) — mêmes transitions partout.
   ============================================================ */
'use strict';

/* ---------- Config ---------- */
const PLAYLIST_MUSIC = 'PLuwwO2tW6rWqsDdYv16-YJyDrtDF3tRan';
const PLAYLIST_ADS   = 'PLTvT8EdA3MszcV7CoKdtCIgiHV_6lrgxg';
const SRC_JINGLE  = 'audio/jingle.mp3';
const SRC_PUBOACV = 'audio/PubOACV.mp3';

const XF_MUSIC_MUSIC = 5;    // crossfade musique → musique (s)
const XF_INTO_BREAK  = 2.2;  // extinction de la musique quand une pub/jingle arrive (s)
const XF_AD_IN       = 1.0;  // montée d'une pub/jingle par-dessus la musique (s)
const XF_AD_AD       = 0.9;  // fondu croisé entre deux pubs / jingle → pub (s)
const XF_OUT_AD      = 1.2;  // extinction d'une pub quand la musique revient (s)
const RAMP_IN        = 1.4;  // montée d'un titre sans chevauchement (s)
const SKIP_FADE      = 0.6;  // fondu du bouton passer (s)
const TICK_MS        = 200;

const MUSICS_BEFORE_BREAK = [5, 7];  // musiques entre deux coupures pub
const ADS_PER_BREAK       = [2, 3];  // pubs par coupure
const PUBOACV_WEIGHT      = 4;       // la pub maison passe un peu plus souvent que les autres
                                     // (1 = même poids qu'une pub ordinaire)
const JINGLE_EVERY        = [4, 6];  // jingle toutes les X musiques
const FAIL_COOLDOWN       = 15 * 60 * 1000;
const PLAYLIST_MAX_PAGES  = 12;  // une page ≈ 100 titres : couvre de très longues playlists
const PLAYLIST_MIN_PLAUSIBLE = 40; // en dessous, on soupçonne une source tronquée

const PIPED_INSTANCES = [
  'https://pipedapi.kavin.rocks',
  'https://pipedapi.adminforge.de',
  'https://api.piped.private.coffee',
  'https://pipedapi.drgns.space',
  'https://pipedapi.leptons.xyz',
];
const INVIDIOUS_INSTANCES = [
  'https://inv.nadeko.net',
  'https://invidious.nerdvpn.de',
  'https://yewtu.be',
  'https://invidious.privacyredirect.com',
];

const $ = id => document.getElementById(id);
const ri  = (a,b) => a + Math.floor(Math.random() * (b - a + 1));
const fmt = t => { t = Math.max(0, Math.floor(t||0)); return Math.floor(t/60) + ':' + String(t%60).padStart(2,'0'); };
const clamp01 = v => Math.min(1, Math.max(0, v));
const smooth = k => k*k*(3-2*k);
const decodeHTML = s => { const t = document.createElement('textarea'); t.innerHTML = s; return t.value; };
/* Mélange réellement aléatoire : Fisher-Yates alimenté par crypto.getRandomValues
   (uniforme et non prévisible d'une session à l'autre ; Math.random seul peut
   reproduire le même ordre au démarrage selon l'implémentation du navigateur). */
function randInt(n){
  if (n <= 1) return 0;
  try {
    const c = window.crypto;
    if (c && c.getRandomValues){
      const lim = Math.floor(4294967296 / n) * n;
      const buf = new Uint32Array(1);
      let v;
      do { c.getRandomValues(buf); v = buf[0]; } while (v >= lim);   // suppression du biais modulo
      return v % n;
    }
  } catch(e){ /* repli ci-dessous */ }
  return Math.floor(Math.random() * n);
}
function shuffle(arr){
  for (let i = arr.length - 1; i > 0; i--){
    const j = randInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* Mémoire d'antenne persistante : le lancement suivant ne rejoue pas les titres
   déjà passés et ne peut pas redémarrer sur le morceau de la session précédente. */
const RECENT_KEY = 'oacv_recent';
const RECENT_MAX = 30;        // grande bibliothèque : on garde une plus longue mémoire
function loadRecent(){
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(a) ? a.filter(x => typeof x === 'string').slice(0, RECENT_MAX) : [];
  } catch(e){ return []; }
}
function saveRecent(){
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(S.lastPlayed.slice(0, RECENT_MAX))); } catch(e){}
}

function cleanTitle(raw){
  let t = decodeHTML(raw || '');
  t = t.replace(/[\(\[\{【]\s*([^\)\]\}】]*)[\)\]\}】]/g, (m, inner) =>
    /(official|video|audio|lyric|mv|m\/v|visuali|hd|4k|clip|paroles|sub|eng|rom|han|color|teaser|trailer|remaster|version|edit|explicit|full|hq|intent)/i.test(inner) ? ' ' : m
  );
  t = t.replace(/\s*[-–—|]\s*(official|clip|audio|video|lyric[s]?).*$/i, '');
  return t.replace(/\s+/g,' ').trim() || raw || 'Sans titre';
}

/* ---------- État global ---------- */
const S = {
  players: [],            // rotation [{yt, videoId, ready, dom, chId}] + 1 lecteur "fetch"
  active: null,           // canal en cours { id, seg, type:'yt'|'local', player?, audio? }
  fading: null,           // canal en cours d'extinction
  chSeq: 0,
  state: 'idle',          // idle | starting | playing | local | paused | skipping
  resumeState: 'playing',
  tweens: [],
  master: 0.8,
  musicPool: [], adsPool: [],
  recentFail: new Map(),
  currentSeg: null,
  lastPlayed: loadRecent(),
  startWatch: { elapsed: 0, retries: 0, id: null },
  ending: false,
};

/* ---------- Chargement des playlists (multi-sources) ---------- */
async function fetchJSON(url, timeout = 9000){
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

const vidFromUrl = u => {
  const m = String(u||'').match(/[?&]v=([\w-]{11})/) || String(u||'').match(/^([\w-]{11})$/);
  return m ? m[1] : null;
};

/* Une page Piped ≈ 100 titres. On suit le jeton « nextpage » jusqu'au bout :
   sans cela, seule la première page était récupérée (101 titres sur 338).
   On garde aussi les entrées sans titre (resolveMeta les complétera) plutôt
   que de perdre des morceaux de la bibliothèque. */
async function fetchPipedPages(base, plId){
  const items = [];
  let np = null, complete = false;
  for (let page = 0; page < PLAYLIST_MAX_PAGES; page++){
    const url = np
      ? `${base}/nextpage/playlists/${encodeURIComponent(plId)}?nextpage=${encodeURIComponent(np)}`
      : `${base}/playlists/${encodeURIComponent(plId)}`;
    const j = await fetchJSON(url);
    const got = (j.relatedStreams || [])
      .map(s => ({ id: vidFromUrl(s.url), title: s.title || '', author: s.uploaderName || '', thumb: s.thumbnail || '', duration: s.duration || 0 }))
      .filter(v => v.id);
    items.push(...got);
    np = j.nextpage || null;
    if (!np){ complete = true; break; }
    if (!got.length) break;
  }
  return { items, complete };
}

async function fetchViaPiped(plId){
  let best = { items: [], complete: false };
  for (const base of PIPED_INSTANCES){
    try {
      const got = await fetchPipedPages(base, plId);
      if (got.items.length > best.items.length) best = got;
      if (best.complete) break;              // playlist entière récupérée
    } catch(e){ /* instance suivante */ }
  }
  if (!best.items.length) throw new Error('piped: toutes les instances ont échoué');
  console.info(`[OACV] piped : ${best.items.length} titres${best.complete ? ' (playlist complète)' : ' (partiel)'}`);
  return best;
}

/* fusion par identifiant : deux sources ne renvoient pas forcément les mêmes */
function unionVideos(a, b){
  const seen = new Set(a.map(v => v.id));
  for (const v of b){ if (v.id && !seen.has(v.id)){ seen.add(v.id); a.push(v); } }
  return a;
}

async function fetchViaInvidious(plId){
  for (const base of INVIDIOUS_INSTANCES){
    try {
      const j = await fetchJSON(`${base}/api/v1/playlists/${encodeURIComponent(plId)}`);
      const items = (j.videos || [])
        .map(v => ({ id: v.videoId, title: v.title || '', author: v.author || '', thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`, duration: v.lengthSeconds || 0 }))
        .filter(v => v.id);
      if (items.length) return items;
    } catch(e){ /* instance suivante */ }
  }
  throw new Error('invidious: toutes les instances ont échoué');
}

let fetchPlayerBusy = null;
function fetchViaYTPlayer(plId){
  const run = () => new Promise((resolve, reject) => {
    const p = S.players.find(x => x.fetch);
    if (!p || !p.ready) return reject(new Error('lecteur fetch indisponible'));
    let done = false;
    const finish = ids => {
      if (done) return; done = true;
      clearInterval(iv); clearTimeout(to);
      try { p.yt.stopVideo(); } catch(e){}
      p.videoId = null;
      ids && ids.length ? resolve(ids.map(id => ({ id, title: '', author: '', thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, duration: 0 })))
                        : reject(new Error('playlist vide'));
    };
    const iv = setInterval(() => {
      try { const l = p.yt.getPlaylist(); if (l && l.length) finish(l.slice()); } catch(e){}
    }, 400);
    const to = setTimeout(() => finish(null), 12000);
    try {
      p.yt.cuePlaylist({ list: plId, listType: 'playlist', index: 0 });
    } catch(e){ finish(null); }
  });
  const next = fetchPlayerBusy ? fetchPlayerBusy.catch(() => {}) : Promise.resolve();
  fetchPlayerBusy = next.then(run, run);
  return fetchPlayerBusy;
}

async function fetchPlaylist(id, cacheKey, { maxDur = 0, minDur = 0 } = {}){
  try {
    const c = sessionStorage.getItem(cacheKey);
    if (c) return JSON.parse(c);
  } catch(e){}

  let items = [], complete = false;

  /* 1. source principale : Piped, paginée (bibliothèque entière) */
  try {
    const got = await fetchViaPiped(id);
    items = got.items;
    complete = got.complete;
  } catch(e){ /* on tente la suite */ }

  /* 2. si la liste semble tronquée ou courte, on complète avec Invidious
        puis on fusionne (union par identifiant, sans doublon) */
  if (!complete || items.length < PLAYLIST_MIN_PLAUSIBLE){
    try {
      const alt = await fetchViaInvidious(id);
      if (alt && alt.length){
        const avant = items.length;
        items = unionVideos(items, alt);
        console.info(`[OACV] invidious : +${items.length - avant} titres`);
      }
    } catch(e){ /* tant pis */ }
  }

  /* 3. dernier recours : le lecteur YouTube intégré */
  if (!items.length){
    try { items = await fetchViaYTPlayer(id); } catch(e){}
  }
  if (!items || !items.length) throw new Error('impossible de charger la playlist ' + id);

  if (maxDur) {
    const filtered = items.filter(v => !v.duration || v.duration <= maxDur);
    if (filtered.length >= Math.min(5, items.length)) items = filtered;
  }
  if (minDur) {
    const filtered = items.filter(v => !v.duration || v.duration >= minDur);
    if (filtered.length >= Math.min(5, items.length)) items = filtered;
  }
  console.info(`[OACV] playlist ${id} : ${items.length} titres retenus`);
  try { sessionStorage.setItem(cacheKey, JSON.stringify(items)); } catch(e){}
  return items;
}

/* les playlists peuvent contenir plusieurs fois la même vidéo → dédoublonnage obligatoire,
   sinon le sac mélangé peut sortir deux fois de suite le même morceau */
function dedupe(items){
  const seen = new Set();
  const out = [];
  for (const v of items){
    if (seen.has(v.id)) continue;
    seen.add(v.id);
    out.push(v);
  }
  return out;
}

async function loadPools(){
  const [music, ads] = await Promise.all([
    fetchPlaylist(PLAYLIST_MUSIC, 'oacv_music_v2', { maxDur: 15*60, minDur: 60 }),
    fetchPlaylist(PLAYLIST_ADS, 'oacv_ads_v2', { maxDur: 4*60, minDur: 8 }).catch(() => []),
  ]);
  S.musicPool = dedupe(music);
  S.adsPool = dedupe(ads);
}

const metaPending = new Set();
async function resolveMeta(v){
  if (!v || v.title || metaPending.has(v.id)) return;
  metaPending.add(v.id);
  try {
    const j = await fetchJSON('https://noembed.com/embed?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D' + v.id, 8000);
    if (j && j.title){
      v.title = j.title; v.author = j.author_name || v.author;
      refreshQueueUI();
      if (S.currentSeg && S.currentSeg.video && S.currentSeg.video.id === v.id) setStageUI(S.currentSeg);
    }
  } catch(e){ /* tant pis */ }
  finally { metaPending.delete(v.id); }
}

/* ---------- Rotation intelligente (shuffle bags) ---------- */
const musicBag = { bag: [] };

function drawMusic(){
  const isFailing = id => { const f = S.recentFail.get(id); return f && Date.now() - f < FAIL_COOLDOWN; };
  if (!musicBag.bag.length){
    const pool = S.musicPool.filter(v => !isFailing(v.id));
    const recent = new Set(S.lastPlayed.slice(0, 20));   // jamais les 20 derniers titres
    let cands = pool.filter(v => !recent.has(v.id));
    if (cands.length < 3) cands = pool;
    if (!cands.length) cands = S.musicPool.slice();
    musicBag.bag = shuffle(cands.slice());
    const last = S.lastPlayed[0];
    if (last && musicBag.bag.length > 1 && musicBag.bag[musicBag.bag.length - 1].id === last){
      const t = musicBag.bag[0];
      musicBag.bag[0] = musicBag.bag[musicBag.bag.length - 1];
      musicBag.bag[musicBag.bag.length - 1] = t;
    }
  }
  while (musicBag.bag.length){
    let v = musicBag.bag.pop();
    // ceinture et bretelles : jamais le même morceau deux fois de suite
    if (S.lastPlayed[0] === v.id && musicBag.bag.length){
      const alt = musicBag.bag.pop();
      musicBag.bag.unshift(v);
      v = alt;
    }
    if (!isFailing(v.id)) return v;
  }
  return S.musicPool[ri(0, S.musicPool.length - 1)];
}

/* Pubs : sac unique. PubOACV y figure plusieurs fois (PUBOACV_WEIGHT),
   elle tombe donc un peu plus souvent que chaque autre pub. */
const adBag = { bag: [], lastOacv: false };

function buildAdBag(){
  const bag = S.adsPool.map(v => ({ type: 'yt', video: v }));
  const poids = Math.max(1, Math.round(PUBOACV_WEIGHT) || 1);
  for (let i = 0; i < poids; i++) bag.push({ type: 'oacv' });
  shuffle(bag);
  return bag;
}

function drawAd(){
  const isFailing = id => { const f = S.recentFail.get(id); return f && Date.now() - f < FAIL_COOLDOWN; };
  if (!adBag.bag.length) adBag.bag = buildAdBag();

  for (let guard = 0; guard < 10 && adBag.bag.length; guard++){
    const a = adBag.bag.pop();
    if (a.type === 'oacv'){
      /* la pub maison ne doit jamais s'enchaîner avec elle-même :
         on la décale plus loin dans le sac */
      if (adBag.lastOacv && adBag.bag.length > 1){ adBag.bag.unshift(a); continue; }
      adBag.lastOacv = true;
      return a;
    }
    if (!isFailing(a.video.id)){ adBag.lastOacv = false; return a; }
  }

  if (!adBag.bag.length) adBag.bag = buildAdBag();
  const dernier = adBag.bag.pop();
  adBag.lastOacv = !!(dernier && dernier.type === 'oacv');
  return dernier;
}

function makeAdSeg(){
  const a = drawAd();
  if (a.type === 'oacv'){
    return { kind: 'ad', ad: { type: 'oacv', src: SRC_PUBOACV, title: 'Pub OACV' } };
  }
  return { kind: 'ad', ad: { type: 'yt', video: a.video } };
}

/* ---------- Planificateur d'antenne ---------- */
const planner = {
  q: [],
  sinceBreak: 0, sinceJingle: 0,
  needBreak: 0, needJingle: 0,

  init(){
    this.sinceBreak = 0; this.sinceJingle = 0;
    this.needBreak = ri(...MUSICS_BEFORE_BREAK);
    this.needJingle = ri(...JINGLE_EVERY);
    this.q = [{ kind: 'jingle', src: SRC_JINGLE }];
    this.refill();
  },

  refill(){
    while (this.q.length < 6) this.q.push(...this._make());
  },

  _make(){
    const breakDue  = this.sinceBreak  >= this.needBreak;
    const jingleDue = this.sinceJingle >= this.needJingle;

    if (breakDue){
      const group = [];
      if (jingleDue) group.push({ kind: 'jingle', src: SRC_JINGLE });
      const n = ri(...ADS_PER_BREAK);
      for (let i = 0; i < n; i++) group.push(makeAdSeg());
      this.sinceBreak = 0;  this.needBreak  = ri(...MUSICS_BEFORE_BREAK);
      this.sinceJingle = 0; this.needJingle = ri(...JINGLE_EVERY);
      return group;
    }
    if (jingleDue){
      this.sinceJingle = 0; this.needJingle = ri(...JINGLE_EVERY);
      return [{ kind: 'jingle', src: SRC_JINGLE }];
    }
    this.sinceBreak++; this.sinceJingle++;
    return [{ kind: 'music', video: drawMusic() }];
  },

  advance(){
    const seg = this.q.shift();
    this.refill();
    return seg;
  },

  replaceAt(i, seg){ this.q[i] = seg; },
};

/* ---------- Lecteurs YouTube (moteur audio) ---------- */
function createPlayers(){
  const mk = (dom, isFetch) => {
    const yt = new YT.Player(dom, {
      height: '120', width: '200',
      playerVars: { autoplay:0, controls:0, disablekb:1, playsinline:1, rel:0, fs:0, iv_load_policy:3, origin: location.origin },
      events: {
        onReady:       () => { const p = byDom(dom); if (p) p.ready = true; },
        onStateChange: e => onYtState(byDom(dom), e.data),
        onError:       e => onYtError(byDom(dom), e.data),
      },
    });
    S.players.push({ yt, videoId: null, ready: false, dom, fetch: !!isFetch, chId: null });
  };
  ['yt-a','yt-b','yt-c'].forEach(d => mk(d, false));
  mk('fetch-music', true);
}
const byDom = id => S.players.find(p => p.dom === id);
const rotation = () => S.players.filter(p => !p.fetch);
const anyIdle = () => rotation().find(p => !p.chId);
// lecteur déjà préparé avec cette vidéo : uniquement hors canaux actifs/phanomènes en fondu
const holderOf = vid => rotation().find(p => p.videoId === vid && !p.chId);
const isCued = p => p && p.ready && [1,3,5].includes(p.yt.getPlayerState());
const ytPlaying = p => p && p.ready && p.yt.getPlayerState() === 1;

function cueOn(p, videoId){
  try { p.yt.stopVideo(); } catch(e){}
  p.videoId = videoId;
  try { p.yt.cueVideoById({ videoId }); } catch(e){}
}
function setVol(target, v01){
  if (!target) return;
  if (target.type === 'yt'){ try { target.player.yt.setVolume(Math.round(clamp01(v01) * 100)); } catch(e){} }
  else { try { target.audio.volume = clamp01(v01); } catch(e){} }
}
const chVol = ch => {
  if (!ch) return 0;
  if (ch.type === 'yt'){ try { return (ch.player.yt.getVolume() || 0) / 100; } catch(e){ return 0; } }
  return ch.audio ? ch.audio.volume : 0;
};
const chPlaying = ch => {
  if (!ch) return false;
  if (ch.type === 'yt') return ytPlaying(ch.player);
  return ch.audio && !ch.audio.paused;
};

/* tweens de volume — gelés pendant la pause (le tick ne tourne pas) */
function tween(target, from, to, dur, onDone){
  S.tweens.push({ target, from, to, dur, elapsed: 0, onDone });
}
function applyTweens(dt){
  const done = [];
  for (const tw of S.tweens){
    tw.elapsed += dt;
    const k = clamp01(tw.elapsed / tw.dur);
    setVol(tw.target, tw.from + (tw.to - tw.from) * smooth(k));
    if (k >= 1) done.push(tw);
  }
  for (const tw of done){
    S.tweens.splice(S.tweens.indexOf(tw), 1);
    if (tw.onDone) tw.onDone();
  }
}
const killTweens = target => { S.tweens = S.tweens.filter(t => t.target !== target); };

/* ---------- Canaux (musique YT / pub YT / fichier local) ---------- */
function releasePlayer(p){
  if (!p) return;
  p.chId = null;
  try { p.yt.pauseVideo(); } catch(e){}
}

function createChannel(seg){
  const ch = { id: ++S.chSeq, seg, type: null, player: null, audio: null, startedAt: 0, failed: false };
  if (seg.kind === 'ad' && seg.ad.type === 'yt' || seg.kind === 'music'){
    ch.type = 'yt';
    const vid = seg.kind === 'music' ? seg.video.id : seg.ad.video.id;
    let p = holderOf(vid);
    if (!p){
      p = anyIdle();
      if (!p){
        // jamais voler le lecteur d'un canal en fondu de sortie
        const busy = new Set([S.active && S.active.player, S.fading && S.fading.player]);
        p = rotation().find(x => !busy.has(x)) || rotation()[0];
      }
      cueOn(p, vid);
    }
    ch.player = p;
    p.chId = ch.id;
  } else {
    // jingle ou PubOACV : fichier local
    ch.type = 'local';
    const src = seg.kind === 'jingle' ? seg.src : seg.ad.src;
    ch.audio = new Audio(src);
    ch.audio.preload = 'auto';
    ch.audio.addEventListener('ended', () => { if (S.active === ch) segFinished(ch); });
    ch.audio.addEventListener('error', () => {
      if (S.active === ch){ console.warn('[OACV] erreur audio local', src); segFinished(ch); }
    });
  }
  return ch;
}

function startChannel(ch, mode){
  const prev = S.active;
  S.active = ch;
  S.currentSeg = ch.seg;
  S.ending = false;

  setStageUI(ch.seg);
  setVol(ch, 0);

  if (ch.type === 'yt'){
    S.state = 'starting';
    armStartWatch(segVideoId(ch.seg));
    try {
      const p = ch.player;
      if (isCued(p) && p.videoId === segVideoId(ch.seg)){
        p.yt.playVideo();                       // lecteur déjà prêt → démarrage à chaud
      } else {
        p.videoId = segVideoId(ch.seg);
        p.yt.loadVideoById({ videoId: segVideoId(ch.seg) });
        p.yt.playVideo();
      }
    } catch(e){
      console.warn('[OACV] échec démarrage YT', e);
      S.recentFail.set(segVideoId(ch.seg), Date.now());
      S.active = null;
      releaseChannel(ch);
      playNext();
      return;
    }
  } else {
    S.state = 'local';
    ch.startedAt = performance.now();
    ch.audio.play().catch(() => { /* le tick retente */ });
  }

  // courbe de transition selon ce qui vient avant et ce qui arrive
  const prevLive = prev && chPlaying(prev) && !prev.fadingOut;
  let fadeIn = RAMP_IN, fadeOut = 0;
  if (prevLive){
    if (ch.seg.kind === 'music' && prev.seg.kind === 'music'){ fadeIn = XF_MUSIC_MUSIC; fadeOut = XF_MUSIC_MUSIC; }
    else if (ch.seg.kind === 'music'){ fadeIn = XF_OUT_AD; fadeOut = XF_OUT_AD; }             // pub → musique
    else if (prev.seg.kind === 'music'){ fadeIn = XF_AD_IN; fadeOut = XF_INTO_BREAK; }        // musique → pub/jingle
    else { fadeIn = XF_AD_AD; fadeOut = XF_AD_AD; }                                            // pub → pub, jingle → pub
  }

  tween(ch, 0, S.master, fadeIn, () => {
    if (S.active === ch && S.state === 'starting') S.state = 'playing';
  });

  if (prevLive){
    fadeOutChannel(prev, fadeOut);
  }
  refreshQueueUI();
  ensurePreloads();
}

function fadeOutChannel(ch, dur){
  if (!ch || ch.fadingOut) return;
  ch.fadingOut = true;
  S.fading = ch;
  killTweens(ch);
  tween(ch, chVol(ch), 0, dur, () => {
    releaseChannel(ch);
    if (S.fading === ch) S.fading = null;
  });
}

function releaseChannel(ch){
  if (!ch) return;
  killTweens(ch);
  if (ch.type === 'yt'){
    if (ch.player) releasePlayer(ch.player);
  } else if (ch.audio){
    try { ch.audio.pause(); } catch(e){}
    try { ch.audio.src = ''; } catch(e){}
  }
  ch.fadingOut = false;
}

const segVideoId = seg => seg.kind === 'music' ? seg.video.id : (seg.kind === 'ad' && seg.ad.type === 'yt' ? seg.ad.video.id : null);

/* fin naturelle d'un canal (ENDED youtube, ended local) → enchaînement auto */
function segFinished(ch){
  if (S.active !== ch) { releaseChannel(ch); return; }
  S.active = null;
  releaseChannel(ch);         // libère le lecteur/audio pour la rotation
  if (['playing','local','starting'].includes(S.state)){
    playNext();               // 100% automatique, dans tous les cas
  }
}

function armStartWatch(id){
  S.startWatch = { elapsed: 0, retries: 0, id };
}

/* ---------- Orchestration ---------- */
function playNext(){
  const seg = planner.advance();

  if (seg.kind === 'music'){
    if (!seg.video.title) resolveMeta(seg.video);
    S.lastPlayed.unshift(seg.video.id);
    if (S.lastPlayed.length > RECENT_MAX) S.lastPlayed.pop();
    saveRecent();
  }

  const ch = createChannel(seg);
  startChannel(ch);
}

/* preload des prochains contenus YouTube sur les lecteurs libres.
   On ne recycle que les lecteurs dont la vidéo préparée ne sert plus à rien. */
function ensurePreloads(){
  const wants = [];
  for (const up of planner.q.slice(0, 4)){
    if (up.kind === 'music') wants.push(up.video.id);
    else if (up.kind === 'ad' && up.ad.type === 'yt') wants.push(up.ad.video.id);
  }
  if (!wants.length) return;
  const wantSet = new Set(wants);
  const busy = new Set();
  for (const c of [S.active, S.fading]) if (c && c.type === 'yt') busy.add(segVideoId(c.seg));

  const recyclable = rotation().filter(p => !p.chId && !wantSet.has(p.videoId));
  for (const vid of wants){
    if (busy.has(vid)) continue;
    if (rotation().some(p => p.videoId === vid && !p.chId)) continue; // déjà préparé sur un lecteur
    const p = recyclable.shift();
    if (!p) break;
    cueOn(p, vid);
  }
}

/* ---------- Événements lecteurs ---------- */
function onYtState(p, st){
  if (!p || p.fetch) return;
  const ch = S.active;
  const isMine = ch && ch.type === 'yt' && ch.player === p;

  // garde-fou "lecteur fantôme" : un lecteur sans canal ne doit jamais sonner
  if (!p.chId && st === 1){ try { p.yt.pauseVideo(); } catch(e){} return; }

  if (st === 0){ // ENDED
    if (isMine && ['playing','starting','local'].includes(S.state)){
      segFinished(ch);
    }
  }
  if (st === 1 && isMine && S.state === 'starting'){
    S.state = 'playing';
    setStatus('En direct');
  }
}

function onYtError(p, code){
  if (!p || p.fetch) return;
  const vid = p.videoId;
  if (vid) S.recentFail.set(vid, Date.now());
  const i = planner.q.findIndex(s => segVideoId(s) === vid && s.kind === 'music');
  if (i >= 0){
    planner.replaceAt(i, { kind: 'music', video: drawMusic() });
    refreshQueueUI();
    ensurePreloads();
  }
  const ch = S.active;
  if (ch && ch.type === 'yt' && ch.player === p && ['playing','starting','local'].includes(S.state)){
    S.active = null;
    releaseChannel(ch);
    playNext();
  } else if (p.chId){
    p.chId = null;
  }
}

/* ---------- UI ---------- */
const FALLBACK_ADS = ['📢','🚗','🍔','📱','🎧','💪','✈️','🍕','🏥','🛒'];

function setStageUI(seg){
  const chip = $('segment'), title = $('title'), sub = $('subtitle');
  const art = $('art'), fb = $('art-fallback'), em = $('art-emoji'), lb = $('art-label');
  chip.classList.remove('ad','jingle');
  fb.classList.add('hidden');

  if (seg.kind === 'music'){
    chip.textContent = 'MUSIQUE';
    title.textContent = seg.video.title ? cleanTitle(seg.video.title) : 'Titre en cours de chargement…';
    sub.textContent = seg.video.author ? (seg.video.author + ' · Playlist OACV') : 'Playlist OACV';
    art.src = seg.video.thumb;
    art.classList.remove('hidden');
  } else if (seg.kind === 'ad'){
    const isOacv = seg.ad.type === 'oacv';
    chip.textContent = 'PUBLICITÉ'; chip.classList.add('ad');
    title.textContent = isOacv ? 'Pub OACV' : cleanTitle(seg.ad.video.title);
    sub.textContent = isOacv ? 'La publicité de la maison 📻' : 'Publicité';
    art.classList.add('hidden');
    em.textContent = isOacv ? '📻' : FALLBACK_ADS[ri(0, FALLBACK_ADS.length - 1)];
    lb.textContent = 'PUBLICITÉ';
    fb.classList.remove('hidden');
  } else {
    chip.textContent = 'JINGLE'; chip.classList.add('jingle');
    title.textContent = 'Jingle Radio OACV';
    sub.textContent = 'Votre antenne, votre son';
    art.classList.add('hidden');
    em.textContent = '🎧';
    lb.textContent = 'JINGLE';
    fb.classList.remove('hidden');
  }
  document.title = '▶ ' + title.textContent + ' — Radio OACV';
}

function setStatus(txt){ $('status').textContent = txt; }

function setLive(on, label){
  const chip = $('live-chip');
  chip.classList.toggle('on', on);
  chip.innerHTML = '<span class="dot"></span> ' + (on ? 'EN DIRECT' : (label || 'HORS LIGNE'));
}

function refreshQueueUI(){
  const list = $('queue-list');
  list.innerHTML = '';
  const add = (inner, cls) => {
    const li = document.createElement('li');
    if (cls) li.className = cls;
    li.innerHTML = inner;
    list.appendChild(li);
  };
  const segRow = (s, i, now) => {
    const idx = now ? '' : `<span class="q-idx">${i+1}</span>`;
    if (s.kind === 'music'){
      if (!s.video.title) resolveMeta(s.video);
      const t = escapeHtml(s.video.title ? cleanTitle(s.video.title) : 'Chargement…');
      if (now) return `<img src="${s.video.thumb}" alt=""><div class="q-info"><span class="q-title">${t}</span><span class="q-sub">En cours</span></div>`;
      return `${idx}<img src="${s.video.thumb}" alt=""><div class="q-info"><span class="q-title">${t}</span><span class="q-sub">${escapeHtml(s.video.author || 'Playlist OACV')}</span></div>`;
    }
    if (s.kind === 'ad'){
      const isOacv = s.ad.type === 'oacv';
      const t = isOacv ? '📻 Pub OACV' : `📢 ${escapeHtml(cleanTitle(s.ad.video.title))}`;
      const sub = isOacv ? 'La pub de la maison' : 'Publicité';
      return `${idx}<span class="q-info"><span class="q-title">${t}</span><span class="q-sub">${sub}</span></div><span class="q-tag">PUB</span>`;
    }
    return `${idx}<span class="q-info"><span class="q-title">🎧 Jingle OACV</span><span class="q-sub">Antenne</span></div><span class="q-tag jingle">JINGLE</span>`;
  };

  if (S.currentSeg) add(segRow(S.currentSeg, -1, true), 'now');
  planner.q.slice(0, 5).forEach((s, i) => add(segRow(s, i, false)));
}
const escapeHtml = s => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

function updateProgress(cur, dur){
  const bar = $('bar');
  if (dur > 0){
    bar.style.width = (clamp01(cur / dur) * 100) + '%';
    $('t-cur').textContent = fmt(cur);
    $('t-dur').textContent = fmt(dur);
  } else {
    bar.style.width = '0%';
    $('t-cur').textContent = '0:00';
    $('t-dur').textContent = '0:00';
  }
}

function setPlayIcon(playing){
  $('icon-play').classList.toggle('hidden', playing);
  $('icon-pause').classList.toggle('hidden', !playing);
}
function setEq(state){
  const eq = $('eq');
  eq.classList.toggle('on', ['playing','local','starting'].includes(state));
  eq.classList.toggle('offline', state === 'idle' || state === 'paused');
  document.querySelector('.art-wrap').classList.toggle('paused', state === 'paused');
}

/* ---------- Boucle principale ----------
   Horloge dans un Web Worker : elle ne ralentit PAS quand l'onglet passe
   en arrière-plan (les setInterval normaux sont bridés à ~1/min par le
   navigateur, ce qui cassait transitions et enchaînements). */
const clockWorkerSrc = `let iv=null; onmessage=e=>{ if(e.data==='start'&&!iv){ last=Date.now(); iv=setInterval(()=>{ const n=Date.now(); postMessage(n-last); last=n; },200);} if(e.data==='stop'&&iv){clearInterval(iv);iv=null;} }; let last=0;`;
let lastTick = performance.now();
let clockWorker = null;
try {
  clockWorker = new Worker(URL.createObjectURL(new Blob([clockWorkerSrc], { type: 'text/javascript' })));
  clockWorker.onmessage = e => tick(e.data / 1000);
} catch(e){
  setInterval(() => { const n = performance.now(); tick((n - lastTick) / 1000); lastTick = n; }, TICK_MS);
}
function startClock(){ if (clockWorker) clockWorker.postMessage('start'); }

function tick(dt){

  if (S.state === 'paused' || S.state === 'idle') return;
  applyTweens(dt);

  const ch = S.active;
  if (!ch) return;

  /* --- canal fichier local (pub OACV / jingle) --- */
  if (ch.type === 'local'){
    const a = ch.audio;
    if (!a){ segFinished(ch); return; }
    if (a.paused){
      if (performance.now() - ch.startedAt > 2500){
        console.warn('[OACV] fichier local illisible, on enchaîne');
        segFinished(ch);            // introuvable/bloquée → on enchaîne, pas de silence infini
      } else {
        a.play().catch(() => {});
      }
      return;
    }
    const dur = a.duration || 0, cur = a.currentTime;
    updateProgress(cur, dur);
    const rem = dur ? dur - cur : Infinity;
    if (dur > 0 && rem <= XF_AD_AD + 0.3 && rem > 0.25 && !S.ending){
      const nxt = planner.q[0];
      if (nxt && nxt.kind !== 'music'){
        S.ending = true;
        playNext();                 // chevauchement avec la pub suivante / jingle
      }
    }
    return;
  }

  /* --- canal YouTube --- */
  const p = ch.player;
  if (!p || !p.ready) return;
  let cur = 0, dur = 0;
  try { cur = p.yt.getCurrentTime() || 0; dur = p.yt.getDuration() || 0; } catch(e){ return; }

  /* chien de garde universel : un canal censé sonner mais resté muet
     (state 5/-1, cur=0) → retentes de playVideo, puis bascule sur la suite */
  if (['playing','starting','local'].includes(S.state)){
    let st = -99;
    try { st = p.yt.getPlayerState(); } catch(e){}
    if ((st === 5 || st === -1) && cur < 0.3 && !S.ending){
      ch.stall = ch.stall || { t: 0, retries: 0 };
      ch.stall.t += dt;
      if (ch.stall.t > 1.2 && ch.stall.retries < 3){
        ch.stall.retries++; ch.stall.t = 0;
        try { p.yt.playVideo(); } catch(e){}
      } else if (ch.stall.t > 9){
        const vid = segVideoId(ch.seg);
        if (vid) S.recentFail.set(vid, Date.now());
        S.active = null;
        releaseChannel(ch);
        S.state = 'playing';
        playNext();
        return;
      }
    } else if (ch.stall) { ch.stall.t = 0; }
  }

  if (S.state === 'starting'){
    if (cur > 0.3){ S.state = 'playing'; setStatus('En direct'); }
    else {
      S.startWatch.elapsed += dt;
      const marks = [1.5, 4, 8];
      if (S.startWatch.retries < marks.length && S.startWatch.elapsed >= marks[S.startWatch.retries]){
        S.startWatch.retries++;
        try { p.yt.playVideo(); } catch(e){}
      }
      if (S.startWatch.elapsed > 14 && S.startWatch.id){
        S.recentFail.set(S.startWatch.id, Date.now());
        S.active = null;
        releaseChannel(ch);
        S.state = 'playing';
        playNext();
        return;
      }
    }
  }

  updateProgress(cur, dur);

  if (S.state === 'playing' && dur > 0 && !S.ending){
    const rem = dur - cur;
    const nxt = planner.q[0];
    if (!nxt) return;

    if (nxt.kind === 'music'){
      if (rem <= XF_MUSIC_MUSIC + 0.2 && rem > 0.45){
        const target = holderOf(nxt.video.id);
        if (target && isCued(target)){
          S.ending = true;
          playNext();               // crossfade musique → musique
          return;
        }
        ensurePreloads();           // pas encore prêt → on le prépare pour le tick suivant
      }
    } else {
      if (rem <= XF_INTO_BREAK && rem > 0.35){
        S.ending = true;
        playNext();                 // la pub/jingle monte pendant que le titre s'éteint
        return;
      }
    }
  }
}

/* horloge */
const tickClock = () => { $('clock').textContent = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }); };
setInterval(tickClock, 1000); tickClock();
startClock();

/* ---------- Contrôles ---------- */
function pauseAllChannels(){
  for (const ch of [S.active, S.fading]){
    if (!ch) continue;
    if (ch.type === 'yt'){ if (ytPlaying(ch.player)) try { ch.player.yt.pauseVideo(); } catch(e){} }
    else if (ch.audio && !ch.audio.paused){ try { ch.audio.pause(); } catch(e){} }
  }
}

function togglePlay(){
  if (S.state === 'paused'){
    const resume = () => {
      S.state = S.resumeState;
      for (const ch of [S.active, S.fading]){
        if (!ch) continue;
        if (ch.type === 'yt') try { ch.player.yt.playVideo(); } catch(e){}
        else if (ch.audio) try { ch.audio.play(); } catch(e){}
      }
      if (!S.active) playNext();
      setStatus('En direct');
      setLive(true); setPlayIcon(true); setEq(S.state);
    };
    resume();
  } else if (['playing','local','starting'].includes(S.state)){
    S.resumeState = S.state === 'starting' ? 'playing' : S.state;
    S.state = 'paused';
    pauseAllChannels();
    setStatus('En pause');
    setLive(false, 'EN PAUSE'); setPlayIcon(false); setEq('paused');
  } else if (S.state === 'idle' && S.musicPool.length){
    setLive(true); setPlayIcon(true); setEq('starting');
    playNext();
  }
}

function skip(){
  if (!['playing','local','starting'].includes(S.state)) return;
  S.ending = false;
  S.state = 'skipping';
  setStatus('Changement\u2026');
  const cur = S.active;
  if (cur){
    fadeOutChannel(cur, SKIP_FADE);
  }
  S.active = null;
  playNext();
}

$('progress').addEventListener('click', e => {
  const ch = S.active;
  if (S.state !== 'playing' || !ch || ch.type !== 'yt' || !ch.player.ready) return;
  const rect = e.currentTarget.getBoundingClientRect();
  const ratio = clamp01((e.clientX - rect.left) / rect.width);
  try {
    const dur = ch.player.yt.getDuration();
    if (dur > 0) ch.player.yt.seekTo(ratio * dur, true);
  } catch(err){}
});

$('btn-play').addEventListener('click', togglePlay);
$('btn-skip').addEventListener('click', skip);
document.addEventListener('keydown', e => {
  if (e.code === 'Space' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)){ e.preventDefault(); togglePlay(); }
});
$('vol').addEventListener('input', e => {
  S.master = e.target.value / 100;
  for (const tw of S.tweens){ if (tw.to > 0) tw.to = S.master; }
  const ch = S.active;
  if (ch && !S.tweens.some(t => t.target === ch)) setVol(ch, S.master);
});
$('btn-retry').addEventListener('click', () => location.reload());

/* ---------- Démarrage ---------- */
function waitForApi(){
  return new Promise(res => {
    if (window.YT && window.YT.Player) return res();
    const iv = setInterval(() => { if (window.YT && window.YT.Player){ clearInterval(iv); res(); } }, 100);
  });
}

(async function boot(){
  setStatus('Chargement des playlists\u2026');
  await waitForApi();
  createPlayers();
  try {
    await loadPools();
  } catch(e){
    console.error(e);
    $('error-screen').classList.remove('hidden');
    $('error-detail').textContent = 'La playlist musique n\u2019a pas pu être chargée. Vérifie ta connexion internet, puis réessaie.';
    return;
  }
  if (!S.musicPool.length){
    $('error-screen').classList.remove('hidden');
    $('error-detail').textContent = 'La playlist musique est vide ou inaccessible.';
    return;
  }
  planner.init();
  const warm = setInterval(() => {
    if (S.players.some(p => p.ready)){
      ensurePreloads();
      clearInterval(warm);
    }
  }, 150);
  $('btn-play').disabled = false;
  $('btn-skip').disabled = false;
  setStatus('Prêt — appuie sur lecture');
  setEq('idle');
  refreshQueueUI();
})();
