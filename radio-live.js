/* ============================================================
   RADIO OACV — écoute du flux central

   Ce module est le SEUL lien entre le site et la radio. Il ne
   choisit jamais une musique : il écoute /stream et lit ce que le
   serveur diffuse. C'est ce qui fait qu'un auditeur qui arrive au
   milieu d'un morceau le rejoint à sa position, au lieu de
   recommencer une playlist locale.

   Les métadonnées (titre, pochette, type de programme) arrivent par
   une connexion permanente, pour que l'affichage suive exactement ce
   qui est joué.
   ============================================================ */

(() => {
  'use strict';

  /* Adresse du serveur de radio. Vide = même origine.
     Si le site est sur GitHub Pages et la radio sur un autre
     domaine, il faut renseigner cette adresse (voir README). */
  const API_BASE = (window.RADIO_API || '').replace(/\/+$/, '');

  const KINDS = {
    music:       { label: 'Musique',  emoji: '🎵' },
    ad:          { label: 'Publicité', emoji: '📢' },
    jingle:      { label: 'Jingle',  emoji: '📻' },
    announcement:{ label: 'Annonce',  emoji: '🎙️' },
  };

  class RadioLive extends EventTarget {
    constructor(){
      super();
      this.audio = null;
      this.seg = null;            // segment en cours
      this.positionMs = 0;
      this.durationMs = 0;
      this.paused = false;
      this.source = null;
      this.retries = 0;
      this.started = false;
    }

    emit(name, detail){ this.dispatchEvent(new CustomEvent(name, { detail })); }

    /* ---------- démarrage ---------- */

    start(mount = '/stream'){
      if (this.started) return;
      this.started = true;

      const a = document.createElement('audio');
      a.id = 'radio-audio';
      a.preload = 'auto';
      a.crossOrigin = 'anonymous';
      /* l'audio est la source de vérité du direct : on ne gère pas
         nous-mêmes la position, le serveur la donne */
      a.src = API_BASE + mount;
      document.body.appendChild(a);
      this.audio = a;

      a.addEventListener('playing', () => {
        this.paused = false;
        this.emit('playing');
      });
      a.addEventListener('pause', () => { this.paused = true; this.emit('paused'); });
      a.addEventListener('error', () => {
        /* coupure réseau : on se reconnecte au flux en cours, on ne
           repart jamais d'une playlist locale */
        this.emit('reconnecting');
        setTimeout(() => this.connect(), 2000);
      });

      this.connect();
      this.watchMetadata();
      this.tick();
      /* si le serveur a déjà répondu avant que l'appelant ne s'abonne,
         on lui renvoie l'état courant tout de suite */
      if (this.seg){
        this.emit('segment', this.seg);
        this.emit('position', { ms: this.positionMs, dur: this.durationMs, seg: this.seg });
      }
    }

    /* ---------- le flux ---------- */

    connect(){
      if (!this.audio) return;
      /* On repart du flux à l'instant présent : le serveur renvoie ce
         qu'il diffuse maintenant, donc l'auditeur revient au bon
         endroit même après une coupure. */
      this.audio.src = API_BASE + (this.src || '/stream');
      const p = this.audio.play();
      if (p && p.catch) p.catch(() => this.emit('waiting-gesture'));
    }

    setSource(mount){
      this.src = mount;
      this.connect();
    }

    /* ---------- métadonnées ---------- */

    async watchMetadata(){
      /* d'abord l'état immédiat, pour ne pas afficher « en attente » */
      try {
        const r = await fetch(API_BASE + '/api/now-playing', { cache: 'no-store' });
        if (r.ok) this.apply(await r.json().catch(() => null));
      } catch { /* le direct reste audible même sans métadonnées */ }

      /* puis la connexion permanente : chaque changement de morceau
         arrive ici, sans rien demander au site */
      const onMeta = data => { if (data) this.apply(data); };
      sse(API_BASE + '/api/now-playing/stream', onMeta);
    }

    apply(np){
      if (!np || !np.id) return;
      const changed = !this.seg || this.seg.id !== np.id;
      this.seg = np;
      this.durationMs = np.dureeMs || np.durationMs || 0;
      /* position : le serveur l'envoie, et on la fait avancer entre
         deux messages pour que la barre reste fluide */
      this.positionMs = np.positionMs || 0;
      const info = KINDS[np.kind] || KINDS.music;
      /* On rejoue toujours les deux évènements : l'appelant peut
         s'abonner après coup, et l'affichage doit alors se mettre
         à jour quand même. */
      this.emit('segment', np);
      this.emit('position', { ms: this.positionMs, dur: this.durationMs, seg: np });
      this.emit('kind', { kind: np.kind, info });
    }

    /* ---------- progression ---------- */

    /* La position ne vient pas du navigateur : elle vient du serveur.
       Entre deux messages du serveur, on la fait avancer localement
       pour que la barre bouge sans saccade. */
    tick(){
      const step = () => {
        if (this.seg && !this.paused){
          this.positionMs += 200;
          if (this.durationMs && this.positionMs > this.durationMs){
            /* le morceau est fini : on attend la confirmation du
               serveur plutôt que d'inventer la suite */
            this.positionMs = this.durationMs;
          }
          this.emit('position', { ms: this.positionMs, dur: this.durationMs, seg: this.seg });
        }
        setTimeout(step, 200);
      };
      step();
    }

    /* ---------- commandes ---------- */

    toggle(){
      if (!this.audio) return;
      if (this.audio.paused) this.connect();
      else this.audio.pause();
    }

    /* La radio est en direct : on ne peut pas revenir en arrière ni
       sauter un morceau. C'est le principe même d'une radio. */
    seek(){ /* volontairement sans effet */ }

    setVolume(v){
      if (this.audio) this.audio.volume = Math.max(0, Math.min(1, v));
    }

    get volume(){ return this.audio ? this.audio.volume : 1; }

    info(){
      return {
        genre: this.seg?.kind || 'music',
        titre: this.seg?.title || 'Radio OACV',
        artiste: this.seg?.artist || '',
        pochette: this.seg?.thumb || '',
        positionMs: this.positionMs,
        dureeMs: this.durationMs,
        direct: true,
      };
    }
  }

  /* ---------- transports ---------- */

  /* Server-Sent Events : le plus simple et le plus robuste. Le
     navigateur se reconnecte tout seul si la coupure est réseau. */
  function sse(url, onMeta){
    if (typeof EventSource === 'undefined') return null;
    let es;
    try { es = new EventSource(url); } catch { return null; }
    es.addEventListener('message', e => {
      try { onMeta(JSON.parse(e.data)); } catch { /* message illisible */ }
    });
    return es;
  }

  window.RadioLive = RadioLive;
  window.radioLive = new RadioLive();
})();
