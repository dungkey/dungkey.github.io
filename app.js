(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  window.WorkbenchTheme?.bind();

  const yearEl = document.getElementById('year');
  if (yearEl) yearEl.textContent = String(new Date().getFullYear());

  const resumeCard = document.getElementById('resumeCard');
  const resumeTitle = document.getElementById('resumeTitle');
  const resumeMeta = document.getElementById('resumeMeta');
  const resumeFill = document.getElementById('resumeFill');

  /* ---------------- 继续阅读 ---------------- */

  function initResume() {
    if (!resumeCard || !window.ReaderStore) return;
    let raw;
    try {
      raw = JSON.parse(localStorage.getItem('dengxia.progress.v1') || 'null');
    } catch {
      return;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;

    const entries = Object.keys(raw).map((id) => {
      const p = raw[id];
      if (!p || typeof p.updatedAt !== 'number' || typeof p.chapter !== 'number' || p.chapter < 0) return null;
      return {
        id,
        chapter: Math.floor(p.chapter),
        ratio: Math.max(0, Math.min(1, Number(p.ratio) || 0)),
        updatedAt: p.updatedAt,
        chapterTitle: typeof p.chapterTitle === 'string' ? p.chapterTitle : '',
      };
    }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

    if (!entries.length) return;

    let index = 0;
    function tryNext() {
      if (index >= entries.length) return;
      const entry = entries[index++];
      Promise.resolve(window.ReaderStore.get(entry.id)).then((book) => {
        if (!book || typeof book.title !== 'string' || !book.title) {
          tryNext();
          return;
        }
        const total = Number(book.chapterCount) || 0;
        let percent = total > 0 ? ((entry.chapter + entry.ratio) / total) * 100 : 0;
        percent = Math.max(0, Math.min(100, percent));
        const label = entry.chapterTitle || `第 ${entry.chapter + 1} 章`;
        const rounded = Math.round(percent);

        resumeTitle.textContent = book.title;
        resumeMeta.textContent = `${label} · ${rounded}%`;
        resumeFill.style.width = `${percent.toFixed(1)}%`;
        resumeCard.href = `reader/index.html#/read/${encodeURIComponent(entry.id)}/${entry.chapter}`;
        resumeCard.hidden = false;
      }).catch(tryNext);
    }
    tryNext();
  }

  /* ---------------- 音乐播放器 ---------------- */

  const audio = $('#audio');
  const trackEl = $('#track');
  const playBtn = $('#play');
  const prevBtn = $('#prev');
  const nextBtn = $('#next');
  const modeBtn = $('#modeBtn');
  const volBtn = $('#volBtn');
  const volRange = $('#volRange');
  const volMuteBtn = $('#volMuteBtn');
  const volPopover = $('#volPopover');
  const volWrap = volBtn ? volBtn.closest('.deck-vol-wrap') : null;
  const trackListBtn = $('#trackListBtn');
  const deckPlaylist = $('#deckPlaylist');
  const deckPlaylistClose = $('#deckPlaylistClose');
  const deckPlaylistItems = $('#deckPlaylistItems');

  const seekEl = $('#seek');
  const curEl = $('#cur');
  const durEl = $('#dur');
  const titleEl = $('#trackTitle');
  const artistEl = $('#trackArtist');
  const trackCountEl = $('#trackCount');

  const MUSIC_DIR = 'music/';
  const AUDIO_RE = /\.(flac|mp3|m4a|aac|ogg|oga|opus|wav|webm)$/i;
  const STORE_KEY = 'desk-track';
  const STORE_MODE_KEY = 'desk-audio-mode';
  const STORE_VOL_KEY = 'desk-audio-vol';

  let playlist = [];
  let current = 0;
  let dragging = false;
  let pendingSeek = 0;
  let saveTimer = 0;
  let errorStreak = 0;
  let autoplayOnLoad = false;
  let errorTimer = 0;

  let playMode = 'loop'; // 'loop' | 'single' | 'shuffle'
  try {
    const sm = localStorage.getItem(STORE_MODE_KEY);
    if (sm === 'loop' || sm === 'single' || sm === 'shuffle') playMode = sm;
  } catch { /* 忽略读取错误 */ }

  function applyMode(mode, remember) {
    playMode = mode;
    const iconLoop = modeBtn?.querySelector('.icon-mode-loop');
    const iconSingle = modeBtn?.querySelector('.icon-mode-single');
    const iconShuffle = modeBtn?.querySelector('.icon-mode-shuffle');

    if (iconLoop) iconLoop.hidden = mode !== 'loop';
    if (iconSingle) iconSingle.hidden = mode !== 'single';
    if (iconShuffle) iconShuffle.hidden = mode !== 'shuffle';

    const desc = mode === 'single' ? '单曲循环' : (mode === 'shuffle' ? '随机播放' : '列表循环');
    if (modeBtn) {
      modeBtn.setAttribute('aria-label', `播放模式：${desc}`);
      modeBtn.title = `切换播放模式 (当前：${desc})`;
    }
    if (remember) {
      try { localStorage.setItem(STORE_MODE_KEY, mode); } catch { /* 忽略写入错误 */ }
    }
  }

  if (modeBtn) {
    modeBtn.addEventListener('click', () => {
      const nextMode = playMode === 'loop' ? 'single' : (playMode === 'single' ? 'shuffle' : 'loop');
      applyMode(nextMode, true);
    });
  }
  applyMode(playMode, false);

  /* 音量与静音控制 */
  let savedVol = 0.8;
  try {
    const sv = localStorage.getItem(STORE_VOL_KEY);
    if (sv !== null) savedVol = parseFloat(sv);
  } catch { /* 忽略读取错误 */ }
  if (Number.isNaN(savedVol) || savedVol < 0 || savedVol > 1) savedVol = 0.8;
  let lastNonZeroVol = savedVol > 0 ? savedVol : 0.8;

  function setVolOpen(open) {
    if (!volPopover || !volBtn) return;
    volPopover.classList.toggle('is-open', Boolean(open));
    volBtn.setAttribute('aria-expanded', String(Boolean(open)));
  }

  function applyVolume(vol, remember) {
    const clamped = Math.max(0, Math.min(1, vol));
    audio.volume = clamped;
    audio.muted = clamped === 0;
    if (volRange) {
      volRange.value = String(Math.round(clamped * 100));
      volRange.style.setProperty('--p', `${(clamped * 100).toFixed(0)}%`);
    }
    if (clamped > 0) lastNonZeroVol = clamped;

    const iconHigh = volBtn?.querySelector('.icon-vol-high');
    const iconLow = volBtn?.querySelector('.icon-vol-low');
    const iconMute = volBtn?.querySelector('.icon-vol-mute');

    if (iconHigh) iconHigh.hidden = clamped < 0.5;
    if (iconLow) iconLow.hidden = clamped === 0 || clamped >= 0.5;
    if (iconMute) iconMute.hidden = clamped > 0;

    if (volBtn) {
      const level = Math.round(clamped * 100);
      const status = clamped === 0 ? '已静音' : `音量：${level}%`;
      volBtn.setAttribute('aria-label', `${status}，点击打开音量控制`);
      volBtn.title = `${status}，点击打开音量控制`;
    }
    if (volMuteBtn) {
      const muted = clamped === 0;
      volMuteBtn.textContent = muted ? '恢复' : '静音';
      volMuteBtn.setAttribute('aria-label', muted ? '恢复音量' : '静音');
      volMuteBtn.classList.toggle('is-muted', muted);
    }
    if (remember) {
      try { localStorage.setItem(STORE_VOL_KEY, String(clamped)); } catch { /* 忽略写入错误 */ }
    }
  }

  if (volRange) {
    volRange.addEventListener('input', () => {
      applyVolume(Number(volRange.value) / 100, true);
    });
  }

  if (volBtn) {
    volBtn.addEventListener('click', () => {
      setVolOpen(!(volPopover && volPopover.classList.contains('is-open')));
    });
  }

  if (volMuteBtn) {
    volMuteBtn.addEventListener('click', () => {
      applyVolume(audio.volume > 0 ? 0 : lastNonZeroVol, true);
    });
  }

  applyVolume(savedVol, false);

  /* 播放列表抽屉 */
  function renderPlaylistUI() {
    if (!deckPlaylistItems) return;
    deckPlaylistItems.innerHTML = '';
    playlist.forEach((t, i) => {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `deck-playlist-item${i === current ? ' is-active' : ''}`;
      btn.setAttribute('aria-current', i === current ? 'true' : 'false');
      btn.title = t.title + (t.artist ? ` — ${t.artist}` : '');

      const titleSpan = document.createElement('span');
      titleSpan.className = 'deck-playlist-title';
      titleSpan.textContent = `${i + 1}. ${t.title}`;

      const artistSpan = document.createElement('span');
      artistSpan.className = 'deck-playlist-artist';
      artistSpan.textContent = t.artist || '';

      btn.append(titleSpan, artistSpan);
      btn.addEventListener('click', () => {
        loadTrack(i, true);
        closePlaylist();
      });
      li.appendChild(btn);
      deckPlaylistItems.appendChild(li);
    });
  }

  function openPlaylist() {
    if (!deckPlaylist) return;
    renderPlaylistUI();
    deckPlaylist.hidden = false;
    if (trackListBtn) trackListBtn.setAttribute('aria-expanded', 'true');
    const activeItem = deckPlaylistItems?.querySelector('.deck-playlist-item.is-active');
    if (activeItem) activeItem.focus();
    else if (deckPlaylistClose) deckPlaylistClose.focus();
  }

  function closePlaylist() {
    if (!deckPlaylist) return;
    const hadFocus = deckPlaylist.contains(document.activeElement);
    deckPlaylist.hidden = true;
    if (trackListBtn) trackListBtn.setAttribute('aria-expanded', 'false');
    if (hadFocus && trackListBtn) trackListBtn.focus();
  }

  if (trackListBtn) {
    trackListBtn.addEventListener('click', () => {
      if (!deckPlaylist) return;
      if (deckPlaylist.hidden) openPlaylist();
      else closePlaylist();
    });
  }
  if (deckPlaylistClose) {
    deckPlaylistClose.addEventListener('click', closePlaylist);
  }

  /* 统一处理浮层外部点击、失焦与 Escape 关闭 */
  function isInsideVol(target) {
    return (volWrap && volWrap.contains(target)) || (volPopover && volPopover.contains(target));
  }

  document.addEventListener('click', (e) => {
    if (volPopover?.classList.contains('is-open') && !isInsideVol(e.target)) {
      setVolOpen(false);
    }
    if (deckPlaylist && !deckPlaylist.hidden) {
      if (!deckPlaylist.contains(e.target) && !(trackListBtn && trackListBtn.contains(e.target))) {
        closePlaylist();
      }
    }
  });

  document.addEventListener('focusin', (e) => {
    if (volPopover?.classList.contains('is-open') && !isInsideVol(e.target)) {
      setVolOpen(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (deckPlaylist && !deckPlaylist.hidden) {
      closePlaylist();
      return;
    }
    if (volPopover?.classList.contains('is-open')) {
      const focusInside = volPopover.contains(document.activeElement) || document.activeElement === volBtn;
      setVolOpen(false);
      if (focusInside && volBtn) volBtn.focus();
    }
  });

  function decodeName(s) {
    try { return decodeURIComponent(s); } catch { return s; }
  }

  function parseName(file) {
    const base = file.replace(AUDIO_RE, '').trim();
    const clean = base.replace(/^\s*\d{1,3}\s*[._)\-–—]\s*/, '').trim() || base || file;
    const parts = clean.split(/\s+[–—−-]\s+/);
    if (parts.length > 1) {
      return { artist: parts[0].trim(), title: parts.slice(1).join(' – ').trim() };
    }
    return { artist: '精选音乐', title: clean };
  }

  function makeTrack(src, file, extra) {
    const meta = parseName(file);
    return {
      src,
      file,
      title: extra?.title || meta.title,
      artist: extra?.artist || meta.artist,
    };
  }

  function loadFromManifest() {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${MUSIC_DIR}tracks.js`;
      s.onload = () => {
        const list = window.__MUSIC__;
        if (!Array.isArray(list) || !list.length) {
          reject(new Error('清单为空'));
          return;
        }
        const out = [];
        list.forEach((item) => {
          const raw = typeof item === 'string' ? item : item?.file || '';
          if (!raw) return;
          const file = decodeName(raw);
          if (!AUDIO_RE.test(file)) return;
          const src = MUSIC_DIR + file.split('/').map(encodeURIComponent).join('/');
          out.push(makeTrack(src, file, typeof item === 'string' ? null : item));
        });
        resolve(out);
      };
      s.onerror = () => reject(new Error('没有 tracks.js'));
      document.head.appendChild(s);
    });
  }

  function sortTracks(list) {
    return list.sort((a, b) => a.file.localeCompare(b.file, 'zh-CN', { numeric: true }));
  }

  function loadPlaylist() {
    return loadFromManifest().then(sortTracks);
  }

  function pickShuffleIndex() {
    if (playlist.length <= 1) return current;
    let nextIdx;
    do {
      nextIdx = Math.floor(Math.random() * playlist.length);
    } while (nextIdx === current);
    return nextIdx;
  }

  function stampTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  function paintTrack() {
    if (audio.error && audio.error.code !== 1) return;
    const d = audio.duration;
    const known = Number.isFinite(d) && d > 0;
    const p = known ? Math.min(audio.currentTime / d, 1) : 0;

    if (!dragging) {
      seekEl.value = String(Math.round(p * 1000));
      seekEl.style.setProperty('--p', `${(p * 100).toFixed(2)}%`);
      curEl.textContent = stampTime(audio.currentTime);
    }

    if (known) {
      durEl.textContent = stampTime(d);
      seekEl.setAttribute('aria-valuetext', `${stampTime(audio.currentTime)} / ${stampTime(d)}`);
    }

    paintPositionState();
  }

  function paintPositionState() {
    if (!('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
    const d = audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    try {
      navigator.mediaSession.setPositionState({
        duration: d,
        position: Math.min(Math.max(audio.currentTime, 0), d),
        playbackRate: audio.playbackRate || 1,
      });
    } catch { /* 部分浏览器不支持非有限参数 */ }
  }

  function paintMetadata() {
    if (!('mediaSession' in navigator) || typeof window.MediaMetadata !== 'function') return;
    if (!playlist.length) return;
    const t = playlist[current];
    try {
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: t.title,
        artist: t.artist,
        album: '工作台 · Workbench',
      });
    } catch { /* 忽略异常 */ }
  }

  function setPlaying(on) {
    trackEl.classList.toggle('is-playing', on);
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = on ? 'playing' : 'paused';
    if (!on) setBuffering(false);
    if (!playlist.length) return;
    const t = playlist[current];
    playBtn.setAttribute('aria-label', `${on ? '暂停：' : '播放：'}${t.title}${t.artist ? ` — ${t.artist}` : ''}`);
  }

  function setBuffering(on) {
    trackEl.classList.toggle('is-buffering', Boolean(on));
    trackEl.setAttribute('aria-busy', on ? 'true' : 'false');
  }

  function applyTrack() {
    const t = playlist[current];
    if (!t) return;
    titleEl.textContent = t.title;
    titleEl.title = t.title;
    artistEl.textContent = t.artist || '本地音频';
    artistEl.title = t.artist || '';
    trackCountEl.textContent = `${current + 1} / ${playlist.length}`;
    if (trackListBtn) {
      trackListBtn.setAttribute('aria-label', `曲目列表 ${current + 1} / ${playlist.length}`);
    }
    durEl.textContent = '--:--';
    curEl.textContent = '0:00';
    seekEl.value = '0';
    seekEl.style.setProperty('--p', '0%');
    seekEl.setAttribute('aria-valuetext', '0:00');
    paintMetadata();
    if (deckPlaylist && !deckPlaylist.hidden) {
      const focusInside = deckPlaylist.contains(document.activeElement);
      renderPlaylistUI();
      if (focusInside) {
        const activeItem = deckPlaylistItems?.querySelector('.deck-playlist-item.is-active');
        if (activeItem) activeItem.focus();
      }
    }
  }

  function enableControls(on) {
    playBtn.disabled = !on;
    prevBtn.disabled = !on;
    nextBtn.disabled = !on;
    seekEl.disabled = !on;
    if (modeBtn) modeBtn.disabled = !on;
    if (volBtn) volBtn.disabled = !on;
    if (volRange) volRange.disabled = !on;
    if (volMuteBtn) volMuteBtn.disabled = !on;
    if (trackListBtn) trackListBtn.disabled = !on;
  }

  function safePlay() {
    if (playBtn.disabled) return;
    const attempt = audio.play();
    if (attempt && attempt.catch) attempt.catch(() => setPlaying(false));
  }

  function loadTrack(index, autoplay, startAt) {
    if (!playlist.length) return;
    if (errorTimer) {
      window.clearTimeout(errorTimer);
      errorTimer = 0;
    }
    autoplayOnLoad = Boolean(autoplay);
    current = ((index % playlist.length) + playlist.length) % playlist.length;
    pendingSeek = typeof startAt === 'number' && startAt > 0.5 ? startAt : 0;
    applyTrack();
    enableControls(true);
    audio.src = playlist[current].src;
    audio.load();
    setPlaying(false);
    if (autoplay) safePlay();
  }

  playBtn.addEventListener('click', () => {
    if (!playlist.length) return;
    if (audio.paused) safePlay();
    else audio.pause();
  });

  prevBtn.addEventListener('click', () => {
    if (!playlist.length) return;
    if (audio.currentTime > 3) {
      audio.currentTime = 0;
      paintTrack();
      savePosition();
      return;
    }
    const target = playMode === 'shuffle' && playlist.length > 1 ? pickShuffleIndex() : current - 1;
    loadTrack(target, !audio.paused);
  });

  nextBtn.addEventListener('click', () => {
    if (!playlist.length) return;
    const target = playMode === 'shuffle' && playlist.length > 1 ? pickShuffleIndex() : current + 1;
    loadTrack(target, !audio.paused);
  });

  function endDrag() { dragging = false; }

  seekEl.addEventListener('pointerdown', () => { dragging = true; });
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);
  window.addEventListener('blur', () => {
    if (!dragging) return;
    dragging = false;
    paintTrack();
  });
  seekEl.addEventListener('lostpointercapture', endDrag);

  seekEl.addEventListener('input', () => {
    const d = audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const p = Number(seekEl.value) / 1000;
    seekEl.style.setProperty('--p', `${(p * 100).toFixed(2)}%`);
    curEl.textContent = stampTime(p * d);
    seekEl.setAttribute('aria-valuetext', `${stampTime(p * d)} / ${stampTime(d)}`);
  });

  seekEl.addEventListener('change', () => {
    dragging = false;
    const d = audio.duration;
    if (!Number.isFinite(d) || d <= 0) return;
    const p = Number(seekEl.value) / 1000;
    audio.currentTime = p * d;
    paintTrack();
    savePosition();
  });

  audio.addEventListener('play', () => setPlaying(true));
  audio.addEventListener('playing', () => {
    errorStreak = 0;
    setBuffering(false);
  });
  audio.addEventListener('canplay', () => {
    errorStreak = 0;
    setBuffering(false);
  });
  audio.addEventListener('waiting', () => setBuffering(true));
  audio.addEventListener('stalled', () => setBuffering(true));
  audio.addEventListener('pause', () => { setPlaying(false); savePosition(); });
  audio.addEventListener('timeupdate', () => { paintTrack(); scheduleSave(); });
  audio.addEventListener('durationchange', paintTrack);
  audio.addEventListener('loadedmetadata', () => {
    if (pendingSeek > 0) {
      const d = audio.duration;
      const t = Number.isFinite(d) && d > 0 ? Math.min(pendingSeek, Math.max(0, d - 1)) : pendingSeek;
      try { audio.currentTime = t; } catch { /* 忽略跳转失败 */ }
      pendingSeek = 0;
    }
    paintTrack();
  });
  audio.addEventListener('ended', () => {
    if (playMode === 'single' || (playMode === 'shuffle' && playlist.length <= 1)) {
      audio.currentTime = 0;
      safePlay();
    } else if (playMode === 'shuffle') {
      loadTrack(pickShuffleIndex(), true);
    } else {
      loadTrack(current + 1, true);
    }
  });
  audio.addEventListener('error', () => {
    if (!audio.src) return;
    const mediaError = audio.error;
    if (!mediaError || mediaError.code === 1) return;
    const code = mediaError.code;
    const reason = code === 2 ? '读取失败'
      : code === 3 ? '解码失败'
      : code === 4 ? '格式不支持'
      : '无法播放';

    errorStreak += 1;
    setBuffering(false);
    setPlaying(false);

    if (autoplayOnLoad && playlist.length > 1 && errorStreak < playlist.length) {
      artistEl.textContent = '无法播放，正在切换下一首…';
      if (window.console) {
        console.warn(`[music] ${reason}（code ${code || 0}），自动跳过：${audio.src}`);
      }
      errorTimer = window.setTimeout(() => {
        errorTimer = 0;
        loadTrack(current + 1, true);
      }, 1200);
      return;
    }

    artistEl.textContent = `无法播放 · ${reason}`;
    curEl.textContent = '—';
    durEl.textContent = '—';
    seekEl.value = '0';
    seekEl.style.setProperty('--p', '0%');
    seekEl.removeAttribute('aria-valuetext');
    seekEl.disabled = true;
    playBtn.disabled = true;
    if (window.console) {
      console.warn(`[music] ${reason}（code ${code || 0}）：${audio.src}`);
    }
  });

  function savePosition() {
    if (!playlist.length || !playlist[current]) return;
    if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        file: playlist[current].file,
        time: Math.max(0, audio.currentTime || 0),
      }));
    } catch { /* 忽略写入错误 */ }
  }

  function scheduleSave() {
    if (saveTimer) return;
    saveTimer = window.setTimeout(() => { saveTimer = 0; savePosition(); }, 20000);
  }

  function readPosition() {
    try {
      const v = JSON.parse(localStorage.getItem(STORE_KEY) || 'null');
      if (v && typeof v.file === 'string' && typeof v.time === 'number') return v;
    } catch { /* 忽略读取错误 */ }
    return null;
  }

  window.addEventListener('pagehide', savePosition);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePosition();
  });

  function initMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const ms = navigator.mediaSession;
    const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch { /* 不支持的媒体按键 */ } };

    on('play', safePlay);
    on('pause', () => audio.pause());
    on('previoustrack', () => prevBtn.click());
    on('nexttrack', () => nextBtn.click());
    on('seekbackward', (d) => {
      audio.currentTime = Math.max(0, audio.currentTime - (d?.seekOffset || 10));
    });
    on('seekforward', (d) => {
      const limit = Number.isFinite(audio.duration) ? audio.duration : audio.currentTime + 10;
      audio.currentTime = Math.min(limit, audio.currentTime + (d?.seekOffset || 10));
    });
    on('seekto', (d) => {
      if (d && typeof d.seekTime === 'number') audio.currentTime = d.seekTime;
    });
  }

  function bootMusic() {
    loadPlaylist().then((list) => {
      if (!list.length) throw new Error('没有可播放的曲目');
      playlist = list;

      const saved = readPosition();
      let idx = 0;
      let startAt = 0;
      if (saved) {
        const found = playlist.findIndex((item) => item.file === saved.file);
        if (found >= 0) {
          idx = found;
          startAt = saved.time;
        }
      }
      loadTrack(idx, false, startAt);
    }).catch((err) => {
      enableControls(false);
      titleEl.textContent = '暂无本地音频';
      artistEl.textContent = '可放入 music/ 目录';
      trackCountEl.textContent = '0 / 0';
      if (trackListBtn) trackListBtn.setAttribute('aria-label', '曲目列表 0 / 0');
      curEl.textContent = '0:00';
      durEl.textContent = '--:--';
      if (window.console) {
        console.warn(`[music] ${err?.message || '列表读取失败'}`);
      }
    });
  }

  initResume();
  initMediaSession();
  bootMusic();

  if ('serviceWorker' in navigator &&
    (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
    window.addEventListener('load', () => {
      try {
        navigator.serviceWorker.register('sw.js').catch(() => {});
      } catch { /* 忽略注册失败 */ }
    });
  }
})();
