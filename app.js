(function () {
  'use strict';

  var root = document.documentElement;
  function $(sel) { return document.querySelector(sel); }

  /* ---------------- 配色控制与顶级动效 ---------------- */

  var scheme = window.matchMedia ? window.matchMedia('(prefers-color-scheme: light)') : null;
  var themeBtns = Array.prototype.slice.call(document.querySelectorAll('[data-set-theme]'));
  var switchTimer = null;

  function resolveTheme(mode) {
    if (mode === 'dark' || mode === 'light') return mode;
    return scheme && scheme.matches ? 'light' : 'dark';
  }

  function applyThemeState(mode, remember) {
    var resolved = resolveTheme(mode);
    root.setAttribute('data-theme-mode', mode);
    root.setAttribute('data-theme', resolved);
    var meta = document.getElementById('themeColor');
    if (meta) meta.setAttribute('content', resolved === 'light' ? '#f4f5f8' : '#090a0d');
    themeBtns.forEach(function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.setTheme === mode));
    });
    if (remember) {
      try { localStorage.setItem('desk-theme', mode); } catch (e) {}
    }
  }

  function paintTheme(mode, remember, event) {
    var currentMode = root.getAttribute('data-theme-mode') || 'auto';
    var currentTheme = root.getAttribute('data-theme') || resolveTheme(currentMode);
    var targetTheme = resolveTheme(mode);

    if (currentMode === mode && currentTheme === targetTheme) return;

    var reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var canViewTransition = !!document.startViewTransition && !reducedMotion;

    if (currentTheme === targetTheme || reducedMotion) {
      applyThemeState(mode, remember);
      return;
    }

    if (canViewTransition) {
      var x = window.innerWidth / 2;
      var y = window.innerHeight / 2;
      if (event && (typeof event.clientX === 'number') && (event.clientX !== 0 || event.clientY !== 0)) {
        x = event.clientX;
        y = event.clientY;
      } else {
        for (var i = 0; i < themeBtns.length; i++) {
          if (themeBtns[i].dataset.setTheme === mode) {
            var rect = themeBtns[i].getBoundingClientRect();
            x = rect.left + rect.width / 2;
            y = rect.top + rect.height / 2;
            break;
          }
        }
      }

      var endRadius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y)
      );

      try {
        var transition = document.startViewTransition(function () {
          applyThemeState(mode, remember);
        });

        transition.ready.then(function () {
          var clipPath = [
            'circle(0px at ' + x + 'px ' + y + 'px)',
            'circle(' + endRadius + 'px at ' + x + 'px ' + y + 'px)'
          ];

          document.documentElement.animate(
            {
              clipPath: clipPath
            },
            {
              duration: 400,
              easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
              pseudoElement: '::view-transition-new(root)'
            }
          );
        }).catch(function () {});
        return;
      } catch (e) {}
    }

    root.classList.add('is-theme-switching');
    applyThemeState(mode, remember);
    clearTimeout(switchTimer);
    switchTimer = setTimeout(function () {
      root.classList.remove('is-theme-switching');
    }, 350);
  }

  themeBtns.forEach(function (b) {
    b.addEventListener('click', function (e) {
      paintTheme(b.dataset.setTheme, true, e);
    });
  });

  applyThemeState(root.getAttribute('data-theme-mode') || 'auto', false);

  if (scheme) {
    var onSchemeChange = function () {
      if ((root.getAttribute('data-theme-mode') || 'auto') === 'auto') {
        paintTheme('auto', false);
      }
    };
    if (scheme.addEventListener) scheme.addEventListener('change', onSchemeChange);
    else if (scheme.addListener) scheme.addListener(onSchemeChange);
  }

  /* ---------------- 搜索与键盘导航 ---------------- */

  var input = $('#q');
  var clearEl = $('#searchClear');
  var links = Array.prototype.slice.call(document.querySelectorAll('[data-key]'));
  var groups = Array.prototype.slice.call(document.querySelectorAll('[data-group]'));
  var countEl = $('#count');
  var totalEl = $('#total');
  var emptyEl = $('#empty');
  var statusEl = $('#status');
  var resetEl = $('#reset');
  var total = links.length;
  var active = -1;

  totalEl.textContent = String(total).padStart(2, '0');

  function norm(s) {
    return String(s).toLowerCase()
      .replace(/[.\-_/]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  links.forEach(function (a) {
    var name = a.querySelector('.link-title');
    var hint = a.querySelector('.link-domain');
    a._index = norm([
      name ? name.textContent : '',
      hint ? hint.textContent : '',
      a.dataset.key
    ].join(' '));
  });

  function visibleLinks() {
    return links.filter(function (a) { return !a.closest('li').hidden; });
  }

  function setActive(i) {
    var vis = visibleLinks();
    links.forEach(function (a) { a.classList.remove('is-active'); });
    active = i;

    if (i >= 0 && vis[i]) {
      vis[i].classList.add('is-active');
      vis[i].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function filter() {
    var tokens = norm(input.value).split(' ').filter(Boolean);
    var shown = 0;

    groups.forEach(function (group) {
      var n = 0;
      Array.prototype.forEach.call(group.querySelectorAll('[data-key]'), function (a) {
        var hit = tokens.every(function (t) { return a._index.indexOf(t) !== -1; });
        var li = a.closest('li');
        var wasHidden = li.hidden;
        li.hidden = !hit;
        if (hit) {
          n++;
          if (wasHidden) {
            li.classList.remove('is-revealed');
            void li.offsetWidth;
            li.classList.add('is-revealed');
            window.setTimeout(function () { li.classList.remove('is-revealed'); }, 240);
          }
        }
      });
      group.hidden = n === 0;
      shown += n;
    });

    if (clearEl) clearEl.hidden = !input.value;
    countEl.textContent = String(shown).padStart(2, '0');
    emptyEl.hidden = shown !== 0;
    statusEl.textContent = shown === 0
      ? '没有匹配的入口'
      : shown + ' 个入口，共 ' + total + ' 个';
    setActive(-1);
  }

  input.addEventListener('input', filter);
  if (clearEl) {
    clearEl.addEventListener('click', function () {
      input.value = '';
      filter();
      input.focus();
    });
  }
  resetEl.addEventListener('click', function () {
    input.value = '';
    filter();
    input.focus();
  });

  document.addEventListener('keydown', function (e) {
    // 优先支持 Cmd+K / Ctrl+K 全局呼出搜索
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
      e.preventDefault();
      input.focus();
      input.select();
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey) return;

    var activeEl = document.activeElement;
    var tag = (activeEl && activeEl.tagName) || '';
    var isInputActive = tag === 'TEXTAREA' || tag === 'SELECT' ||
      (tag === 'INPUT' && !/^(range|button|checkbox|radio|submit|reset|file|color|image)$/.test(activeEl.type)) ||
      (activeEl && activeEl.isContentEditable);

    if (e.key === '/' && !isInputActive) {
      e.preventDefault();
      input.focus();
      input.select();
      return;
    }

    // 空格键在非输入态下快速播放/暂停音频
    if (e.key === ' ' && !isInputActive && !/^(BUTTON|A)$/.test(tag)) {
      e.preventDefault();
      if (playlist.length) {
        if (audio.paused) safePlay(); else audio.pause();
      }
      return;
    }

    if (e.isComposing || e.keyCode === 229) return;

    if (e.key === 'Escape' && document.activeElement === input) {
      input.value = '';
      filter();
      input.blur();
      return;
    }

    if (document.activeElement !== input) return;

    var vis = visibleLinks();
    if (!vis.length) return;

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(active + 1 >= vis.length ? 0 : active + 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(active - 1 < 0 ? vis.length - 1 : active - 1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (active >= 0 && vis[active]) {
        vis[active].click();
      } else if (input.value.trim().length > 0 && vis[0]) {
        vis[0].click();
      }
    }
  });

  /* ---------------- 音乐播放机体 ---------------- */

  var audio = $('#audio');
  var trackEl = $('#track');
  var playBtn = $('#play');
  var prevBtn = $('#prev');
  var nextBtn = $('#next');
  var modeBtn = $('#modeBtn');
  var volBtn = $('#volBtn');
  var volRange = $('#volRange');
  var trackListBtn = $('#trackListBtn');
  var deckPlaylist = $('#deckPlaylist');
  var deckPlaylistClose = $('#deckPlaylistClose');
  var deckPlaylistItems = $('#deckPlaylistItems');

  var seekEl = $('#seek');
  var curEl = $('#cur');
  var durEl = $('#dur');
  var titleEl = $('#trackTitle');
  var artistEl = $('#trackArtist');
  var trackCountEl = $('#trackCount');

  var MUSIC_DIR = 'music/';
  var AUDIO_RE = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|webm)$/i;
  var STORE_KEY = 'desk-track';
  var STORE_MODE_KEY = 'desk-audio-mode';
  var STORE_VOL_KEY = 'desk-audio-vol';

  var playlist = [];
  var current = 0;
  var dragging = false;
  var pendingSeek = 0;
  var saveTimer = 0;

  var playMode = 'loop'; // 'loop' | 'single' | 'shuffle'
  try {
    var sm = localStorage.getItem(STORE_MODE_KEY);
    if (sm === 'loop' || sm === 'single' || sm === 'shuffle') playMode = sm;
  } catch (e) {}

  function applyMode(mode, remember) {
    playMode = mode;
    var iconLoop = modeBtn ? modeBtn.querySelector('.icon-mode-loop') : null;
    var iconSingle = modeBtn ? modeBtn.querySelector('.icon-mode-single') : null;
    var iconShuffle = modeBtn ? modeBtn.querySelector('.icon-mode-shuffle') : null;

    if (iconLoop) iconLoop.hidden = mode !== 'loop';
    if (iconSingle) iconSingle.hidden = mode !== 'single';
    if (iconShuffle) iconShuffle.hidden = mode !== 'shuffle';

    var desc = mode === 'single' ? '单曲循环' : (mode === 'shuffle' ? '随机播放' : '列表循环');
    if (modeBtn) {
      modeBtn.setAttribute('aria-label', '播放模式：' + desc);
      modeBtn.title = '切换播放模式 (当前：' + desc + ')';
    }
    if (remember) {
      try { localStorage.setItem(STORE_MODE_KEY, mode); } catch (e) {}
    }
  }

  if (modeBtn) {
    modeBtn.addEventListener('click', function () {
      var nextMode = playMode === 'loop' ? 'single' : (playMode === 'single' ? 'shuffle' : 'loop');
      applyMode(nextMode, true);
    });
  }
  applyMode(playMode, false);

  /* 音量与静音控制 */
  var savedVol = 0.8;
  try {
    var sv = localStorage.getItem(STORE_VOL_KEY);
    if (sv !== null) savedVol = parseFloat(sv);
  } catch (e) {}
  if (isNaN(savedVol) || savedVol < 0 || savedVol > 1) savedVol = 0.8;
  var lastNonZeroVol = savedVol > 0 ? savedVol : 0.8;

  function applyVolume(vol, remember) {
    vol = Math.max(0, Math.min(1, vol));
    audio.volume = vol;
    audio.muted = vol === 0;
    if (volRange) {
      volRange.value = String(Math.round(vol * 100));
      volRange.style.setProperty('--p', (vol * 100).toFixed(0) + '%');
    }
    if (vol > 0) lastNonZeroVol = vol;

    var iconHigh = volBtn ? volBtn.querySelector('.icon-vol-high') : null;
    var iconLow = volBtn ? volBtn.querySelector('.icon-vol-low') : null;
    var iconMute = volBtn ? volBtn.querySelector('.icon-vol-mute') : null;

    if (iconHigh) iconHigh.hidden = vol < 0.5;
    if (iconLow) iconLow.hidden = vol === 0 || vol >= 0.5;
    if (iconMute) iconMute.hidden = vol > 0;

    if (volBtn) {
      volBtn.setAttribute('aria-label', vol === 0 ? '已静音，点击恢复' : '音量：' + Math.round(vol * 100) + '%');
      volBtn.title = vol === 0 ? '已静音 (点击恢复音量)' : '音量：' + Math.round(vol * 100) + '% (点击静音)';
    }
    if (remember) {
      try { localStorage.setItem(STORE_VOL_KEY, String(vol)); } catch (e) {}
    }
  }

  if (volRange) {
    volRange.addEventListener('input', function () {
      applyVolume(Number(volRange.value) / 100, true);
    });
  }

  if (volBtn) {
    volBtn.addEventListener('click', function () {
      if (audio.volume > 0) {
        applyVolume(0, true);
      } else {
        applyVolume(lastNonZeroVol, true);
      }
    });
  }
  applyVolume(savedVol, false);

  /* 播放列表抽屉 */
  function renderPlaylistUI() {
    if (!deckPlaylistItems) return;
    deckPlaylistItems.innerHTML = '';
    playlist.forEach(function (t, i) {
      var li = document.createElement('li');
      li.className = 'deck-playlist-item' + (i === current ? ' is-active' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === current));

      var titleSpan = document.createElement('span');
      titleSpan.className = 'deck-playlist-title';
      titleSpan.textContent = (i + 1) + '. ' + t.title;

      var artistSpan = document.createElement('span');
      artistSpan.className = 'deck-playlist-artist';
      artistSpan.textContent = t.artist || '';

      li.appendChild(titleSpan);
      li.appendChild(artistSpan);

      li.addEventListener('click', function () {
        loadTrack(i, true);
        closePlaylist();
      });
      deckPlaylistItems.appendChild(li);
    });
  }

  function openPlaylist() {
    if (!deckPlaylist) return;
    renderPlaylistUI();
    deckPlaylist.hidden = false;
    if (trackListBtn) trackListBtn.setAttribute('aria-expanded', 'true');
  }

  function closePlaylist() {
    if (!deckPlaylist) return;
    deckPlaylist.hidden = true;
    if (trackListBtn) trackListBtn.setAttribute('aria-expanded', 'false');
  }

  if (trackListBtn) {
    trackListBtn.addEventListener('click', function () {
      if (!deckPlaylist) return;
      if (deckPlaylist.hidden) openPlaylist();
      else closePlaylist();
    });
  }
  if (deckPlaylistClose) {
    deckPlaylistClose.addEventListener('click', closePlaylist);
  }

  function decodeName(s) {
    try { return decodeURIComponent(s); } catch (e) { return s; }
  }

  function parseName(file) {
    var base = file.replace(AUDIO_RE, '').trim();
    var clean = base.replace(/^\s*\d{1,3}\s*[._)\-–—]\s*/, '').trim() || base || file;
    var parts = clean.split(/\s+[–—−-]\s+/);
    if (parts.length > 1) {
      return { artist: parts[0].trim(), title: parts.slice(1).join(' – ').trim() };
    }
    return { artist: '精选音乐', title: clean };
  }

  function makeTrack(src, file, extra) {
    var meta = parseName(file);
    return {
      src: src,
      file: file,
      title: (extra && extra.title) || meta.title,
      artist: (extra && extra.artist) || meta.artist
    };
  }

  function loadFromListing() {
    return fetch(MUSIC_DIR, { cache: 'no-store' }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    }).then(function (html) {
      var doc = new DOMParser().parseFromString(html, 'text/html');
      var base = new URL(MUSIC_DIR, location.href);
      var seen = Object.create(null);
      var out = [];

      Array.prototype.forEach.call(doc.querySelectorAll('a[href]'), function (a) {
        var href = a.getAttribute('href');
        if (!href) return;
        var url;
        try { url = new URL(href, base); } catch (e) { return; }
        if (url.origin !== base.origin) return;
        var file = decodeName(url.pathname.split('/').pop() || '');
        if (!AUDIO_RE.test(file) || seen[url.href]) return;
        seen[url.href] = true;
        out.push(makeTrack(url.href, file));
      });

      if (!out.length) throw new Error('目录里没有音频');
      return out;
    });
  }

  function loadFromManifest() {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = MUSIC_DIR + 'tracks.js';
      s.onload = function () {
        var list = window.__MUSIC__;
        if (!Array.isArray(list) || !list.length) { reject(new Error('清单为空')); return; }
        var out = [];
        list.forEach(function (item) {
          var raw = typeof item === 'string' ? item : (item && item.file) || '';
          if (!raw) return;
          var file = decodeName(raw);
          var src = MUSIC_DIR + file.split('/').map(encodeURIComponent).join('/');
          out.push(makeTrack(src, file, typeof item === 'string' ? null : item));
        });
        resolve(out);
      };
      s.onerror = function () { reject(new Error('没有 tracks.js')); };
      document.head.appendChild(s);
    });
  }

  function sortTracks(list) {
    return list.sort(function (a, b) {
      return a.file.localeCompare(b.file, 'zh-CN', { numeric: true });
    });
  }

  function loadPlaylist() {
    var isStaticHost = location.hostname.endsWith('github.io') || location.protocol === 'file:';
    var first = (!isStaticHost && /^https?:$/.test(location.protocol))
      ? loadFromListing()
      : Promise.reject(new Error('静态环境直读 tracks.js'));
    return first.catch(loadFromManifest).then(sortTracks);
  }

  function stampTime(sec) {
    if (!isFinite(sec) || sec < 0) sec = 0;
    var m = Math.floor(sec / 60);
    var s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function paintTrack() {
    if (audio.error && audio.error.code !== 1) return;
    var d = audio.duration;
    var known = isFinite(d) && d > 0;
    var p = known ? Math.min(audio.currentTime / d, 1) : 0;

    if (!dragging) {
      seekEl.value = String(Math.round(p * 1000));
      seekEl.style.setProperty('--p', (p * 100).toFixed(2) + '%');
      curEl.textContent = stampTime(audio.currentTime);
    }

    if (known) {
      durEl.textContent = stampTime(d);
      seekEl.setAttribute('aria-valuetext', stampTime(audio.currentTime) + ' / ' + stampTime(d));
    }

    paintPositionState();
  }

  function paintPositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    var d = audio.duration;
    if (!isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        position: Math.min(Math.max(audio.currentTime, 0), d),
        playbackRate: audio.playbackRate || 1
      });
    } catch (e) {}
  }

  function paintMetadata() {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;
    if (!playlist.length) return;
    var t = playlist[current];
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: '工作台 · Workbench'
      });
    } catch (e) {}
  }

  function setPlaying(on) {
    trackEl.classList.toggle('is-playing', on);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
    if (!on) setBuffering(false);
    if (!playlist.length) return;
    var t = playlist[current];
    playBtn.setAttribute('aria-label', (on ? '暂停：' : '播放：') + t.title + (t.artist ? ' — ' + t.artist : ''));
  }

  function setBuffering(on) {
    trackEl.classList.toggle('is-buffering', !!on);
    trackEl.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function applyTrack() {
    var t = playlist[current];
    if (!t) return;
    titleEl.textContent = t.title;
    artistEl.textContent = t.artist || '本地音频';
    trackCountEl.textContent = (current + 1) + ' / ' + playlist.length;
    durEl.textContent = '--:--';
    curEl.textContent = '0:00';
    seekEl.value = '0';
    seekEl.style.setProperty('--p', '0%');
    seekEl.setAttribute('aria-valuetext', '0:00');
    paintMetadata();
    if (deckPlaylist && !deckPlaylist.hidden) renderPlaylistUI();
  }

  function enableControls(on) {
    playBtn.disabled = !on;
    prevBtn.disabled = !on;
    nextBtn.disabled = !on;
    seekEl.disabled = !on;
    if (modeBtn) modeBtn.disabled = !on;
    if (volBtn) volBtn.disabled = !on;
    if (volRange) volRange.disabled = !on;
    if (trackListBtn) trackListBtn.disabled = !on;
  }

  function safePlay() {
    if (playBtn.disabled) return;
    var attempt = audio.play();
    if (attempt && attempt.catch) attempt.catch(function () { setPlaying(false); });
  }

  function loadTrack(index, autoplay, startAt) {
    if (!playlist.length) return;
    current = ((index % playlist.length) + playlist.length) % playlist.length;
    pendingSeek = typeof startAt === 'number' && startAt > 0.5 ? startAt : 0;
    applyTrack();
    enableControls(true);
    audio.src = playlist[current].src;
    audio.load();
    setPlaying(false);
    if (autoplay) safePlay();
  }

  playBtn.addEventListener('click', function () {
    if (!playlist.length) return;
    if (audio.paused) safePlay(); else audio.pause();
  });

  prevBtn.addEventListener('click', function () {
    if (!playlist.length) return;
    if (playMode === 'shuffle' && playlist.length > 1) {
      var nextIdx;
      do {
        nextIdx = Math.floor(Math.random() * playlist.length);
      } while (nextIdx === current);
      loadTrack(nextIdx, !audio.paused);
    } else {
      loadTrack(current - 1, !audio.paused);
    }
  });

  nextBtn.addEventListener('click', function () {
    if (!playlist.length) return;
    if (playMode === 'shuffle' && playlist.length > 1) {
      var nextIdx;
      do {
        nextIdx = Math.floor(Math.random() * playlist.length);
      } while (nextIdx === current);
      loadTrack(nextIdx, !audio.paused);
    } else {
      loadTrack(current + 1, !audio.paused);
    }
  });

  function endDrag() { dragging = false; }

  seekEl.addEventListener('pointerdown', function () { dragging = true; });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', function () {
    if (!dragging) return;
    dragging = false;
    paintTrack();
  });
  seekEl.addEventListener('lostpointercapture', endDrag);

  seekEl.addEventListener('input', function () {
    var d = audio.duration;
    if (!isFinite(d) || d <= 0) return;
    var p = Number(seekEl.value) / 1000;
    seekEl.style.setProperty('--p', (p * 100).toFixed(2) + '%');
    curEl.textContent = stampTime(p * d);
    seekEl.setAttribute('aria-valuetext', stampTime(p * d) + ' / ' + stampTime(d));
  });

  seekEl.addEventListener('change', function () {
    dragging = false;
    var d = audio.duration;
    if (!isFinite(d) || d <= 0) return;
    var p = Number(seekEl.value) / 1000;
    audio.currentTime = p * d;
    paintTrack();
    savePosition();
  });

  audio.addEventListener('play', function () { setPlaying(true); });
  audio.addEventListener('playing', function () { setBuffering(false); });
  audio.addEventListener('canplay', function () { setBuffering(false); });
  audio.addEventListener('waiting', function () { setBuffering(true); });
  audio.addEventListener('stalled', function () { setBuffering(true); });
  audio.addEventListener('pause', function () { setPlaying(false); savePosition(); });
  audio.addEventListener('timeupdate', function () { paintTrack(); scheduleSave(); });
  audio.addEventListener('durationchange', paintTrack);
  audio.addEventListener('loadedmetadata', function () {
    if (pendingSeek > 0) {
      var d = audio.duration;
      var t = isFinite(d) && d > 0 ? Math.min(pendingSeek, Math.max(0, d - 1)) : pendingSeek;
      try { audio.currentTime = t; } catch (e) {}
      pendingSeek = 0;
    }
    paintTrack();
  });
  audio.addEventListener('ended', function () {
    if (playMode === 'single') {
      audio.currentTime = 0;
      safePlay();
    } else if (playMode === 'shuffle') {
      if (playlist.length <= 1) {
        audio.currentTime = 0;
        safePlay();
      } else {
        var nextIdx;
        do {
          nextIdx = Math.floor(Math.random() * playlist.length);
        } while (nextIdx === current);
        loadTrack(nextIdx, true);
      }
    } else {
      loadTrack(current + 1, true);
    }
  });
  audio.addEventListener('error', function () {
    if (!audio.src) return;
    var mediaError = audio.error;
    if (!mediaError || mediaError.code === 1) return;
    var code = mediaError.code;
    var reason = code === 2 ? '读取失败'
      : code === 3 ? '解码失败'
      : code === 4 ? '格式不支持'
      : '无法播放';

    setBuffering(false);
    setPlaying(false);
    artistEl.textContent = '无法播放 · ' + reason;
    curEl.textContent = '—';
    durEl.textContent = '—';
    seekEl.value = '0';
    seekEl.style.setProperty('--p', '0%');
    seekEl.removeAttribute('aria-valuetext');
    seekEl.disabled = true;
    playBtn.disabled = true;
    if (window.console) {
      console.warn('[music] ' + reason + '（code ' + (code || 0) + '）：' + audio.src);
    }
  });

  function savePosition() {
    if (!playlist.length || !playlist[current]) return;
    if (!isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        file: playlist[current].file,
        time: Math.max(0, audio.currentTime || 0)
      }));
    } catch (e) {}
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = setTimeout(function () { saveTimer = 0; savePosition(); }, 5000);
  }

  function readPosition() {
    try {
      var v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && typeof v.file === 'string' && typeof v.time === 'number') return v;
    } catch (e) {}
    return null;
  }

  window.addEventListener('pagehide', savePosition);

  function initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    var ms = navigator.mediaSession;
    function on(action, fn) { try { ms.setActionHandler(action, fn); } catch (e) {} }

    on('play', safePlay);
    on('pause', function () { audio.pause(); });
    on('previoustrack', function () { prevBtn.click(); });
    on('nexttrack', function () { nextBtn.click(); });
    on('seekbackward', function (d) {
      audio.currentTime = Math.max(0, audio.currentTime - ((d && d.seekOffset) || 10));
    });
    on('seekforward', function (d) {
      var limit = isFinite(audio.duration) ? audio.duration : audio.currentTime + 10;
      audio.currentTime = Math.min(limit, audio.currentTime + ((d && d.seekOffset) || 10));
    });
    on('seekto', function (d) {
      if (d && typeof d.seekTime === 'number') audio.currentTime = d.seekTime;
    });
  }

  function bootMusic() {
    loadPlaylist().then(function (list) {
      if (!list.length) throw new Error('没有可播放的曲目');
      playlist = list;

      var saved = readPosition();
      var idx = 0;
      var startAt = 0;
      if (saved) {
        for (var i = 0; i < playlist.length; i++) {
          if (playlist[i].file === saved.file) { idx = i; startAt = saved.time; break; }
        }
      }
      loadTrack(idx, false, startAt);
    }).catch(function (err) {
      enableControls(false);
      titleEl.textContent = '暂无本地音频';
      artistEl.textContent = '可放入 music/ 目录';
      trackCountEl.textContent = '0 / 0';
      curEl.textContent = '0:00';
      durEl.textContent = '--:--';
      if (window.console) {
        console.warn('[music] ' + (err && err.message ? err.message : '列表读取失败'));
      }
    });
  }

  /* ---------------- 纯粹时钟 ---------------- */

  var clockEl = document.getElementById('clock');
  var dateEl = document.getElementById('date');
  var yearEl = document.getElementById('year');
  var weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  function tick() {
    var d = new Date();
    clockEl.textContent = d.toLocaleTimeString('zh-CN', { hour12: false });
    clockEl.setAttribute('datetime', d.toISOString());
    dateEl.textContent = d.getFullYear() + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + String(d.getDate()).padStart(2, '0') + ' · ' + weekdays[d.getDay()];
  }

  tick();
  setTimeout(function () {
    tick();
    setInterval(tick, 1000);
  }, 1000 - (Date.now() % 1000));

  filter();
  initMediaSession();
  bootMusic();
})();
