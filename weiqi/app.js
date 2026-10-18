(function () {
  'use strict';

  const Go = window.Go;
  const GoAI = window.GoAI;
  const KOMI = 3.5;
  const AI_TIME_LIMIT = 2100;
  const FALLBACK_AI_TIME_LIMIT = 1650;
  const CANVAS_MAX_DPR = 2;
  const CHINESE_NUMERALS = { 5: '五', 6: '六' };
  const REVIEW_PLAYOUTS = 20;
  const REVIEW_TOP_N = 5;
  const MAX_ARCHIVES = 8;
  const REVIEW_RANK_COLORS = ['#2f7d5b', '#3b6fa0', '#b07a2a'];

  const $ = (id) => document.getElementById(id);

  const els = {
    boardKicker: $('boardKicker'),
    boardTitle: $('boardTitle'),
    turnPillStone: $('turnPillStone'),
    turnPillText: $('turnPillText'),

    boardFrame: $('boardFrame'),
    canvas: $('goBoard'),
    resultLayer: $('resultLayer'),
    resultStone: $('resultStone'),
    resultTitle: $('resultTitle'),
    resultDetail: $('resultDetail'),
    resultCaption: $('resultCaption'),
    againBtn: $('againBtn'),
    reviewBtn: $('reviewBtn'),
    reviewGameBtn: $('reviewGameBtn'),

    boardHint: $('boardHint'),
    lastMoveInfo: $('lastMoveInfo'),
    showResultBtn: $('showResultBtn'),
    reviewChipBtn: $('reviewChipBtn'),

    sizeControl: $('sizeControl'),
    sizeHint: $('sizeHint'),
    colorControl: $('colorControl'),
    newGameBtn: $('newGameBtn'),
    historyReviewBtn: $('historyReviewBtn'),

    reviewPanel: $('reviewPanel'),
    reviewMeta: $('reviewMeta'),
    reviewGameSelect: $('reviewGameSelect'),
    reviewRefreshBtn: $('reviewRefreshBtn'),
    reviewCloseBtn: $('reviewCloseBtn'),
    reviewProgressBar: $('reviewProgressBar'),
    reviewProgressText: $('reviewProgressText'),
    reviewBoardMove: $('reviewBoardMove'),
    reviewBoardSide: $('reviewBoardSide'),
    reviewBoardSvg: $('reviewBoardSvg'),
    reviewBoardNote: $('reviewBoardNote'),
    reviewChart: $('reviewChart'),
    reviewTableBody: $('reviewTableBody'),
    reviewFootnote: $('reviewFootnote'),

    gameMeta: $('gameMeta'),
    statusStone: $('statusStone'),
    statusText: $('statusText'),
    statusSide: $('statusSide'),
    moveMetric: $('moveMetric'),
    blackCapMetric: $('blackCapMetric'),
    whiteCapMetric: $('whiteCapMetric'),

    passBtn: $('passBtn'),
    resignBtn: $('resignBtn'),

    toast: $('toast'),
    liveRegion: $('liveRegion'),
  };

  const canvas = els.canvas;
  const ctx = canvas.getContext('2d');
  const TAU = Math.PI * 2;

  const state = {
    size: 5,
    humanColor: Go.BLACK,
    selectedSize: 5,
    selectedColor: Go.BLACK,
    board: null,
    geo: null,
    toMove: Go.BLACK,
    ko: -1,
    captures: { 1: 0, 2: 0 },
    moveNumber: 0,
    passes: 0,
    lastMove: -1,
    lastAction: null,
    phase: 'playing',
    result: null,
    aiStats: null,
    history: [],
    archives: [],
    archiveCounter: 0,
    review: {
      open: false,
      token: 0,
      archiveId: null,
      positions: [],
      selected: 0,
    },
    gameId: 0,
    hover: null,
    stoneAnimation: null,
    drawFrame: null,
    aiTimer: null,
    fallbackTimer: null,
    toastTimer: null,
  };

  const view = {
    cssSize: 0,
    pad: 0,
    cell: 0,
    dpr: 1,
  };

  let aiWorker = null;
  let workerDisabled = false;
  let requestCounter = 0;
  const pendingAI = new Map();

  /* -----------------------------------------------------------------------
   * AI worker
   * --------------------------------------------------------------------- */

  function initAIWorker() {
    if (workerDisabled || typeof Worker === 'undefined' || window.location.protocol === 'file:') {
      return;
    }

    try {
      aiWorker = new Worker('ai-worker.js');
      aiWorker.onmessage = (event) => {
        const message = event.data || {};
        const pending = pendingAI.get(message.id);
        if (!pending) return;
        pendingAI.delete(message.id);
        if (message.error) {
          pending.reject(new Error(message.error));
        } else {
          pending.resolve(message.result);
        }
      };

      aiWorker.onerror = (event) => {
        console.warn('AI worker 不可用，切换到主线程计算。', event.message || event);
        workerDisabled = true;
        if (aiWorker) {
          aiWorker.terminate();
          aiWorker = null;
        }
        const error = new Error('AI worker error');
        pendingAI.forEach((pending) => pending.reject(error));
        pendingAI.clear();
      };
    } catch (error) {
      console.warn('无法创建 AI worker，切换到主线程计算。', error);
      workerDisabled = true;
      aiWorker = null;
    }
  }

  function cancelledError() {
    const error = new Error('AI request cancelled');
    error.cancelled = true;
    return error;
  }

  function stopAITasks() {
    if (state.aiTimer) {
      window.clearTimeout(state.aiTimer);
      state.aiTimer = null;
    }
    if (state.fallbackTimer) {
      window.clearTimeout(state.fallbackTimer);
      state.fallbackTimer = null;
    }

    pendingAI.forEach((pending) => pending.reject(cancelledError()));
    pendingAI.clear();

    if (aiWorker) {
      aiWorker.terminate();
      aiWorker = null;
    }
  }

  function requestAIMove(payload) {
    if (!aiWorker) {
      return runAIOnMainThread(payload);
    }

    return new Promise((resolve, reject) => {
      const id = ++requestCounter;
      pendingAI.set(id, { resolve, reject });
      try {
        aiWorker.postMessage({ id, ...payload });
      } catch (error) {
        pendingAI.delete(id);
        aiWorker.terminate();
        aiWorker = null;
        workerDisabled = true;
        reject(error);
      }
    });
  }

  function runAIOnMainThread(payload) {
    return new Promise((resolve, reject) => {
      if (state.fallbackTimer) {
        window.clearTimeout(state.fallbackTimer);
      }
      // 留出一帧，让界面先绘制出来。
      state.fallbackTimer = window.setTimeout(() => {
        state.fallbackTimer = null;
        try {
          const result = payload.type === 'analyze'
            ? GoAI.analyzePosition(payload)
            : GoAI.chooseMove({
              ...payload,
              timeLimit: Math.min(payload.timeLimit || FALLBACK_AI_TIME_LIMIT, FALLBACK_AI_TIME_LIMIT),
            });
          resolve(result);
        } catch (error) {
          reject(error);
        }
      }, 70);
    });
  }

  async function getAIMove(payload) {
    try {
      return await requestAIMove(payload);
    } catch (error) {
      if (error && error.cancelled) throw error;
      console.warn('AI 首次计算失败，尝试改用主线程。', error);
      return runAIOnMainThread(payload);
    }
  }

  /* -----------------------------------------------------------------------
   * Review worker
   *
   * 复盘分析和对局 AI 分开线程，避免历史复盘拖慢当前对局。
   * --------------------------------------------------------------------- */

  let reviewWorker = null;
  let reviewWorkerDisabled = false;
  const pendingReview = new Map();

  function initReviewWorker() {
    if (
      reviewWorkerDisabled
      || reviewWorker
      || typeof Worker === 'undefined'
      || window.location.protocol === 'file:'
    ) {
      return;
    }

    try {
      reviewWorker = new Worker('ai-worker.js');
      reviewWorker.onmessage = (event) => {
        const message = event.data || {};
        const pending = pendingReview.get(message.id);
        if (!pending) return;
        pendingReview.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      };

      reviewWorker.onerror = (event) => {
        console.warn('复盘 worker 不可用，切换到主线程计算。', event.message || event);
        reviewWorkerDisabled = true;
        if (reviewWorker) {
          reviewWorker.terminate();
          reviewWorker = null;
        }
        const error = new Error('review worker error');
        pendingReview.forEach((pending) => pending.reject(error));
        pendingReview.clear();
      };
    } catch (error) {
      console.warn('无法创建复盘 worker，切换到主线程计算。', error);
      reviewWorkerDisabled = true;
      reviewWorker = null;
    }
  }

  function stopReviewTasks() {
    pendingReview.forEach((pending) => pending.reject(cancelledError()));
    pendingReview.clear();
    if (reviewWorker) {
      reviewWorker.terminate();
      reviewWorker = null;
    }
  }

  function requestReviewAnalysis(payload) {
    if (!reviewWorker) return runAIOnMainThread(payload);

    return new Promise((resolve, reject) => {
      const id = ++requestCounter;
      pendingReview.set(id, { resolve, reject });
      try {
        reviewWorker.postMessage({ id, ...payload });
      } catch (error) {
        pendingReview.delete(id);
        reviewWorker.terminate();
        reviewWorker = null;
        reviewWorkerDisabled = true;
        reject(error);
      }
    });
  }

  async function getReviewAnalysis(payload) {
    initReviewWorker();
    try {
      return await requestReviewAnalysis(payload);
    } catch (error) {
      if (error && error.cancelled) throw error;
      console.warn('复盘计算失败，尝试改用主线程。', error);
      return runAIOnMainThread(payload);
    }
  }

  /* -----------------------------------------------------------------------
   * Game lifecycle
   * --------------------------------------------------------------------- */

  function startNewGame() {
    state.gameId += 1;
    stopAITasks();
    stopReviewTasks();

    state.size = state.selectedSize;
    state.humanColor = state.selectedColor;
    state.geo = Go.makeGeometry(state.size);
    state.board = Go.newBoard(state.size);
    state.toMove = Go.BLACK;
    state.ko = -1;
    state.captures = { 1: 0, 2: 0 };
    state.moveNumber = 0;
    state.passes = 0;
    state.lastMove = -1;
    state.lastAction = null;
    state.phase = 'playing';
    state.result = null;
    state.aiStats = null;
    state.history = [];
    state.hover = null;
    state.stoneAnimation = null;

    state.review.open = false;
    state.review.token += 1;
    state.review.archiveId = null;
    state.review.positions = [];
    state.review.selected = 0;

    els.resultLayer.hidden = true;
    els.showResultBtn.hidden = true;
    els.reviewChipBtn.hidden = true;
    els.reviewPanel.hidden = true;

    initAIWorker();
    updateSetupUi();
    updateUi();
    resizeCanvas();
    announce(
      `${CHINESE_NUMERALS[state.size]}路棋局开始，你执${state.humanColor === Go.BLACK ? '黑' : '白'}。`,
    );

    if (state.humanColor === Go.WHITE) {
      enterAITurn();
    }
  }

  function opponentColor(color) {
    return color === Go.BLACK ? Go.WHITE : Go.BLACK;
  }

  function colorName(color) {
    return color === Go.BLACK ? '黑' : '白';
  }

  function aiColor() {
    return opponentColor(state.humanColor);
  }

  function enterAITurn() {
    if (state.result || state.phase === 'over') return;
    if (state.toMove !== aiColor()) return;

    state.phase = 'ai';
    state.hover = null;
    updateUi();
    drawBoard();

    if (state.aiTimer) window.clearTimeout(state.aiTimer);
    state.aiTimer = window.setTimeout(() => {
      state.aiTimer = null;
      runAITurn();
    }, 210);
  }

  async function runAITurn() {
    if (state.phase !== 'ai' || state.toMove !== aiColor() || state.result) return;

    const gameId = state.gameId;
    const color = aiColor();
    const payload = {
      size: state.size,
      board: Array.from(state.board),
      toMove: color,
      aiColor: color,
      ko: state.ko,
      komi: KOMI,
      opponentPassed: state.passes === 1,
      lastMove: state.lastMove,
      timeLimit: AI_TIME_LIMIT,
    };

    let response;
    try {
      response = await getAIMove(payload);
    } catch (error) {
      if (error && error.cancelled) return;
      if (gameId !== state.gameId) return;
      console.error('AI 计算失败。', error);
      showToast('AI 计算异常，本手自动停一手');
      doPass(color);
      return;
    }

    if (gameId !== state.gameId || state.phase !== 'ai' || state.result) return;

    if (response && response.stats) {
      state.aiStats = response.stats;
    }

    if (!response || response.move === -1 || !Number.isInteger(response.move)) {
      doPass(color);
      return;
    }

    const result = Go.play(state.board, state.geo, response.move, color, state.ko);
    if (!result) {
      console.warn('AI 返回了非法着法，改为停一手。', response.move);
      showToast('AI 着法异常，本手自动停一手');
      doPass(color);
      return;
    }

    placeStone(color, response.move, result);
  }

  function placeStone(color, idx, result) {
    const boardBefore = state.board.slice();
    Go.unplay(boardBefore, idx, color, result.captured);
    state.history.push({
      moveNumber: state.moveNumber + 1,
      color,
      idx,
      pass: false,
      captured: result.captured.length,
      boardBefore: Array.from(boardBefore),
      koBefore: state.ko,
      passesBefore: state.passes,
      lastMoveBefore: state.lastMove,
    });

    state.ko = result.ko;
    state.passes = 0;
    state.captures[color] += result.captured.length;
    state.moveNumber += 1;
    state.lastMove = idx;
    state.lastAction = {
      type: 'move',
      color,
      idx,
      captured: result.captured.length,
    };
    state.toMove = opponentColor(color);
    state.phase = 'playing';
    state.hover = null;
    state.stoneAnimation = {
      idx,
      startedAt: performance.now(),
    };

    updateUi();
    drawBoard();
    announce(
      `${colorName(color)}棋落子 ${Go.pointLabel(idx, state.size)}${result.captured.length ? `，提${result.captured.length}子` : ''}。`,
    );

    if (state.toMove === aiColor()) {
      enterAITurn();
    }
  }

  function doPass(color) {
    state.history.push({
      moveNumber: state.moveNumber + 1,
      color,
      idx: -1,
      pass: true,
      captured: 0,
      boardBefore: Array.from(state.board),
      koBefore: state.ko,
      passesBefore: state.passes,
      lastMoveBefore: state.lastMove,
    });

    state.passes += 1;
    state.ko = -1;
    state.moveNumber += 1;
    state.lastMove = -1;
    state.lastAction = { type: 'pass', color };
    state.toMove = opponentColor(color);
    state.phase = 'playing';
    state.hover = null;

    if (state.passes >= 2) {
      finishGame('score');
      return;
    }

    updateUi();
    drawBoard();
    announce(`${colorName(color)}棋停一手。`);

    if (state.toMove === aiColor()) {
      enterAITurn();
    }
  }

  function finishGame(reason) {
    state.gameId += 1;
    stopAITasks();
    state.phase = 'over';
    state.hover = null;

    const judge = Go.judge(state.board, state.geo, KOMI);
    if (reason === 'resign') {
      state.result = {
        reason: 'resign',
        winner: aiColor(),
        judge,
      };
    } else {
      state.result = {
        reason: 'score',
        winner: judge.winner,
        judge,
      };
    }

    archiveCurrentGame();
    updateUi();
    drawBoard();
    showResult();
    announce(resultAnnouncement());
  }

  function handleResign() {
    if (state.phase === 'over') return;
    finishGame('resign');
  }

  /* -----------------------------------------------------------------------
   * Human interaction
   * --------------------------------------------------------------------- */

  function canHumanPlay() {
    return state.phase === 'playing'
      && state.toMove === state.humanColor
      && !state.result;
  }

  function pointFromPointer(event) {
    if (!view.cssSize) return null;

    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;

    const x = (event.clientX - rect.left) * (view.cssSize / rect.width);
    const y = (event.clientY - rect.top) * (view.cssSize / rect.height);
    const col = Math.round((x - view.pad) / view.cell);
    const row = Math.round((y - view.pad) / view.cell);

    if (col < 0 || col >= state.size || row < 0 || row >= state.size) return null;

    const cx = view.pad + col * view.cell;
    const cy = view.pad + row * view.cell;
    if (Math.hypot(x - cx, y - cy) > view.cell * 0.46) return null;

    return row * state.size + col;
  }

  function handleCanvasPointerDown(event) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    if (!canHumanPlay()) return;

    const idx = pointFromPointer(event);
    if (idx === null) return;
    if (state.board[idx] !== Go.EMPTY) {
      rejectMove('这里已经有棋子了');
      return;
    }
    if (idx === state.ko) {
      rejectMove('打劫：不能立即提回');
      return;
    }

    const result = Go.play(state.board, state.geo, idx, state.humanColor, state.ko);
    if (!result) {
      rejectMove('不能自杀落子');
      return;
    }

    placeStone(state.humanColor, idx, result);
  }

  function handlePointerMove(event) {
    if (event.pointerType === 'touch' || !canHumanPlay()) {
      if (state.hover !== null) {
        state.hover = null;
        drawBoard();
      }
      return;
    }

    const idx = pointFromPointer(event);
    let nextHover = idx;
    if (nextHover !== null) {
      if (state.board[nextHover] !== Go.EMPTY || nextHover === state.ko) {
        nextHover = null;
      } else {
        const testBoard = state.board.slice();
        if (!Go.play(testBoard, state.geo, nextHover, state.humanColor, state.ko)) {
          nextHover = null;
        }
      }
    }

    if (nextHover === state.hover) return;
    state.hover = nextHover;
    drawBoard();
  }

  function clearHover() {
    if (state.hover === null) return;
    state.hover = null;
    drawBoard();
  }

  function rejectMove(message) {
    els.boardFrame.classList.remove('is-shaking');
    // 强制重启动画
    void els.boardFrame.offsetWidth;
    els.boardFrame.classList.add('is-shaking');
    window.setTimeout(() => els.boardFrame.classList.remove('is-shaking'), 360);
    showToast(message);
  }

  function handlePass() {
    if (!canHumanPlay()) return;
    doPass(state.humanColor);
  }

  /* -----------------------------------------------------------------------
   * Result display
   * --------------------------------------------------------------------- */

  function showResult() {
    if (!state.result) return;
    renderResult();
    els.resultLayer.hidden = false;
    els.showResultBtn.hidden = true;
    window.requestAnimationFrame(() => {
      if (!els.resultLayer.hidden) els.againBtn.focus({ preventScroll: true });
    });
  }

  function hideResult() {
    els.resultLayer.hidden = true;
    els.showResultBtn.hidden = false;
    els.boardFrame.focus?.({ preventScroll: true });
    announce('已关闭结果面板，可以查看棋盘。');
  }

  function renderResult() {
    const result = state.result;
    if (!result) return;

    const winner = result.winner;
    els.resultStone.className = `result-stone ${winner === Go.BLACK ? 'black' : winner === Go.WHITE ? 'white' : ''}`;

    if (result.reason === 'resign') {
      els.resultTitle.textContent = winner === state.humanColor ? '你赢了' : 'AI 获胜';
      els.resultDetail.textContent = '你按下了认输，棋局就此结束。';
      els.resultCaption.textContent = '胜败乃兵家常事，不妨再来一局。';
      return;
    }

    const judge = result.judge;
    if (winner === Go.EMPTY) {
      els.resultTitle.textContent = '双方和棋';
      els.resultDetail.textContent =
        `黑 ${judge.black} 子 · 白 ${judge.white} 子 + 贴目 ${judge.komi} 目 = ${judge.whiteTotal} 目`;
      els.resultCaption.textContent = '双方目数相同，平局 · 双方连续停一手，数子终局';
      return;
    }

    const humanWon = winner === state.humanColor;
    const blackWon = winner === Go.BLACK;
    const margin = judge.margin.toFixed(1);
    const title = humanWon ? '你赢了' : 'AI 获胜';

    els.resultTitle.textContent = title;
    els.resultDetail.textContent =
      `黑 ${judge.black} 子 · 白 ${judge.white} 子 + 贴目 ${judge.komi} 目 = ${judge.whiteTotal} 目`;
    els.resultCaption.textContent =
      `${blackWon ? '黑' : '白'}胜 ${margin} 目 · 双方连续停一手，数子终局`;
  }

  function resultAnnouncement() {
    const result = state.result;
    if (!result) return '';
    if (result.reason === 'resign') {
      return `${result.winner === state.humanColor ? '你获胜' : 'AI 获胜'}，你选择了认输。`;
    }
    const judge = result.judge;
    if (result.winner === Go.EMPTY) {
      return `终局，双方和棋。黑棋 ${judge.black} 子，白棋 ${judge.whiteTotal} 目。`;
    }
    const side = result.winner === Go.BLACK ? '黑棋' : '白棋';
    return `终局，${side}胜 ${judge.margin.toFixed(1)} 目。黑棋 ${judge.black} 子，白棋 ${judge.whiteTotal} 目。`;
  }

  /* -----------------------------------------------------------------------
   * Review
   * --------------------------------------------------------------------- */

  function percentText(rate) {
    if (!Number.isFinite(rate)) return '—';
    return `${(rate * 100).toFixed(1)}%`;
  }

  function reviewStarPoints(size) {
    if (size === 5) return [[2, 2], [1, 1], [1, 3], [3, 1], [3, 3]];
    if (size === 6) return [[2, 2], [2, 3], [3, 2], [3, 3]];
    return [];
  }

  function archiveCurrentGame() {
    if (!state.result) return null;

    const archive = {
      id: ++state.archiveCounter,
      createdAt: Date.now(),
      size: state.size,
      humanColor: state.humanColor,
      komi: KOMI,
      history: state.history.map((entry) => ({
        ...entry,
        boardBefore: Array.from(entry.boardBefore),
      })),
      board: state.board.slice(),
      toMove: state.toMove,
      ko: state.ko,
      passes: state.passes,
      lastMove: state.lastMove,
      moveNumber: state.moveNumber,
      result: state.result,
      reviewPositions: null,
      analysisResults: [],
      analysisStatus: 'idle',
      analysisSelected: null,
    };

    state.archives.push(archive);
    if (state.archives.length > MAX_ARCHIVES) state.archives.shift();
    state.review.archiveId = archive.id;
    updateArchiveSelect();
    return archive;
  }

  function activeArchive() {
    return state.archives.find((archive) => archive.id === state.review.archiveId) || null;
  }

  function buildReviewPositions(archive) {
    const positions = archive.history.map((entry) => ({
      board: entry.boardBefore,
      toMove: entry.color,
      ko: entry.koBefore,
      passes: entry.passesBefore,
      lastMove: entry.lastMoveBefore,
      playedMove: entry.pass ? -1 : entry.idx,
    }));

    positions.push({
      board: Array.from(archive.board),
      toMove: archive.toMove,
      ko: archive.ko,
      passes: archive.passes,
      lastMove: archive.lastMove,
      playedMove: null,
    });

    return positions;
  }

  function archiveLabel(archive) {
    const humanSide = archive.humanColor === Go.BLACK ? '黑' : '白';
    let outcome;
    if (archive.result.reason === 'resign') {
      outcome = archive.result.winner === archive.humanColor ? '你胜' : '认输';
    } else {
      outcome = archive.result.winner === archive.humanColor ? '你胜' : 'AI 胜';
    }
    return `第 ${archive.id} 局 · ${archive.size} 路 · 你执${humanSide} · ${outcome} · ${archive.moveNumber} 手`;
  }

  function updateArchiveSelect() {
    const select = els.reviewGameSelect;
    const label = select.closest('.review-select-label');
    if (label) label.hidden = state.archives.length === 0;

    select.innerHTML = state.archives
      .map((archive) => `<option value="${archive.id}">${archiveLabel(archive)}</option>`)
      .join('');

    if (state.review.archiveId) {
      select.value = String(state.review.archiveId);
    }

    els.historyReviewBtn.hidden = state.archives.length === 0;
  }

  function openReview(archiveId) {
    if (state.archives.length === 0) {
      showToast('还没有可以复盘的对局');
      return;
    }

    const archive = state.archives.find((item) => item.id === archiveId)
      || state.archives[state.archives.length - 1];

    state.review.open = true;
    state.review.archiveId = archive.id;

    if (!archive.reviewPositions) {
      archive.reviewPositions = buildReviewPositions(archive);
    }
    state.review.positions = archive.reviewPositions;
    state.review.selected = Number.isInteger(archive.analysisSelected)
      ? archive.analysisSelected
      : archive.reviewPositions.length - 1;

    els.reviewPanel.hidden = false;
    els.resultLayer.hidden = true;
    updateArchiveSelect();
    updateUi();
    renderReview();

    if (archive.analysisStatus !== 'done') {
      runReviewAnalysis();
    }

    try {
      els.reviewPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (error) {
      els.reviewPanel.scrollIntoView();
    }
  }

  function closeReview() {
    state.review.open = false;
    els.reviewPanel.hidden = true;

    const archive = activeArchive();
    if (archive && archive.analysisStatus === 'running') {
      state.review.token += 1;
      archive.analysisStatus = 'idle';
    }
    stopReviewTasks();
    updateUi();
  }

  function setReviewArchive(archiveId) {
    const archive = state.archives.find((item) => item.id === archiveId);
    if (!archive || archive.id === state.review.archiveId) return;

    const previous = activeArchive();
    if (previous && previous.analysisStatus === 'running') {
      previous.analysisStatus = 'idle';
    }
    state.review.token += 1;
    stopReviewTasks();

    state.review.archiveId = archive.id;
    if (!archive.reviewPositions) {
      archive.reviewPositions = buildReviewPositions(archive);
    }
    state.review.positions = archive.reviewPositions;
    state.review.selected = Number.isInteger(archive.analysisSelected)
      ? archive.analysisSelected
      : archive.reviewPositions.length - 1;

    updateArchiveSelect();
    renderReview();

    if (archive.analysisStatus !== 'done') {
      runReviewAnalysis();
    }
  }

  async function runReviewAnalysis(force = false) {
    const archive = activeArchive();
    if (!archive || archive.analysisStatus === 'running') return;

    if (!archive.reviewPositions) {
      archive.reviewPositions = buildReviewPositions(archive);
    }
    state.review.positions = archive.reviewPositions;

    if (force) {
      archive.analysisResults = [];
      archive.analysisStatus = 'idle';
      archive.analysisSelected = null;
      state.review.selected = archive.reviewPositions.length - 1;
    }

    const positions = archive.reviewPositions;
    const results = archive.analysisResults;
    const token = ++state.review.token;

    archive.analysisStatus = 'running';
    renderReview();

    for (let index = 0; index < positions.length; index += 1) {
      if (results[index]) continue;

      const position = positions[index];
      let response;
      try {
        response = await getReviewAnalysis({
          type: 'analyze',
          size: archive.size,
          board: position.board,
          toMove: position.toMove,
          ko: position.ko,
          passes: position.passes,
          komi: archive.komi,
          lastMove: position.lastMove,
          playedMove: position.playedMove,
          playoutsPerMove: REVIEW_PLAYOUTS,
          topN: REVIEW_TOP_N,
        });
      } catch (error) {
        if (error && error.cancelled) {
          archive.analysisStatus = 'idle';
          return;
        }
        console.error('复盘分析失败。', error);
        archive.analysisStatus = 'error';
        renderReview();
        return;
      }

      if (token !== state.review.token) {
        archive.analysisStatus = 'idle';
        return;
      }

      results[index] = response;
      renderReview();
    }

    archive.analysisStatus = 'done';
    renderReview();
  }

  function renderReview() {
    if (!state.review.open) return;

    const archive = activeArchive();
    if (!archive) return;

    const positions = archive.reviewPositions || [];
    const results = archive.analysisResults || [];
    const total = positions.length;
    const done = results.filter(Boolean).length;

    state.review.positions = positions;
    state.review.selected = Math.max(
      0,
      Math.min(state.review.selected, Math.max(0, total - 1)),
    );
    archive.analysisSelected = state.review.selected;

    const humanSide = archive.humanColor === Go.BLACK ? '黑' : '白';
    const outcome = archive.result.winner === archive.humanColor ? '你获胜' : 'AI 获胜';
    els.reviewMeta.textContent =
      `${archive.size} 路 · 你执${humanSide} · 共 ${archive.moveNumber} 手 · ${outcome}`;

    const percent = total > 0 ? Math.round((done / total) * 100) : 0;
    els.reviewProgressBar.style.width = `${archive.analysisStatus === 'done' ? 100 : percent}%`;

    if (archive.analysisStatus === 'done') {
      els.reviewProgressText.textContent =
        `分析完成 · ${total} 个局面 · 每个点 ${REVIEW_PLAYOUTS} 次推演`;
    } else if (archive.analysisStatus === 'error') {
      els.reviewProgressText.textContent = '分析中断，可点击“重新分析”重试';
    } else if (archive.analysisStatus === 'running') {
      els.reviewProgressText.textContent = `正在分析 ${done} / ${total} 个局面…`;
    } else {
      els.reviewProgressText.textContent = `已分析 ${done} / ${total} 个局面`;
    }

    els.reviewRefreshBtn.disabled = archive.analysisStatus === 'running';
    els.reviewFootnote.textContent =
      `每个局面会对棋盘上所有合法点（含停一手）各做 ${REVIEW_PLAYOUTS} 次推演；`
      + '胜率为行棋方视角，折线图换算为黑棋胜率。';

    renderReviewBoard(archive);
    renderReviewChart(archive);
    renderReviewTable(archive);
  }

  function renderReviewBoard(archive) {
    const positions = archive.reviewPositions || [];
    if (positions.length === 0) return;

    const index = state.review.selected;
    const position = positions[index];
    const analysis = archive.analysisResults[index];
    const isFinal = index === positions.length - 1;
    const size = archive.size;
    const width = 320;
    const pad = 30;
    const cell = (width - pad * 2) / (size - 1);

    if (index === 0) {
      els.reviewBoardMove.textContent = '开局（第 1 手落子前）';
    } else if (isFinal) {
      els.reviewBoardMove.textContent = `终局局面（共 ${archive.moveNumber} 手）`;
    } else {
      els.reviewBoardMove.textContent = `第 ${index} 手落子后（第 ${index + 1} 手前）`;
    }
    els.reviewBoardSide.textContent = isFinal ? '终局' : `轮到${colorName(position.toMove)}棋`;

    const pointX = (idx) => pad + (idx % size) * cell;
    const pointY = (idx) => pad + Math.floor(idx / size) * cell;

    const gradients = `
      <defs>
        <radialGradient id="reviewStoneBlack" cx="34%" cy="28%" r="76%">
          <stop offset="0" stop-color="#6d7069"/>
          <stop offset="0.42" stop-color="#2a2c28"/>
          <stop offset="1" stop-color="#080907"/>
        </radialGradient>
        <radialGradient id="reviewStoneWhite" cx="34%" cy="28%" r="76%">
          <stop offset="0" stop-color="#ffffff"/>
          <stop offset="0.62" stop-color="#f0eade"/>
          <stop offset="1" stop-color="#c6bcaa"/>
        </radialGradient>
        <linearGradient id="reviewWood" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#e0b97f"/>
          <stop offset="0.55" stop-color="#d3a465"/>
          <stop offset="1" stop-color="#bd884b"/>
        </linearGradient>
      </defs>`;

    let svg = `${gradients}<rect width="${width}" height="${width}" rx="18" fill="url(#reviewWood)"/>`;
    svg += `<rect x="1" y="1" width="${width - 2}" height="${width - 2}" rx="17" fill="none" stroke="rgba(90,56,24,0.25)"/>`;

    const gridStroke = 'rgba(65, 42, 19, 0.72)';
    for (let line = 0; line < size; line += 1) {
      const pos = pad + line * cell;
      svg += `<line x1="${pad}" y1="${pos}" x2="${width - pad}" y2="${pos}" stroke="${gridStroke}" stroke-width="1"/>`;
      svg += `<line x1="${pos}" y1="${pad}" x2="${pos}" y2="${width - pad}" stroke="${gridStroke}" stroke-width="1"/>`;
    }

    for (const [sx, sy] of reviewStarPoints(size)) {
      svg += `<circle cx="${pad + sx * cell}" cy="${pad + sy * cell}" r="2" fill="rgba(60,38,17,0.8)"/>`;
    }

    for (let i = 0; i < size; i += 1) {
      svg += `<text x="${pad + i * cell}" y="${width - pad * 0.34}" text-anchor="middle" font-size="8" fill="rgba(71,45,20,0.55)">${Go.LETTERS[i]}</text>`;
      svg += `<text x="${pad * 0.34}" y="${pad + i * cell + 3}" text-anchor="middle" font-size="8" fill="rgba(71,45,20,0.55)">${size - i}</text>`;
    }

    position.board.forEach((color, idx) => {
      if (color === Go.EMPTY) return;
      const fill = color === Go.BLACK ? 'url(#reviewStoneBlack)' : 'url(#reviewStoneWhite)';
      const stroke = color === Go.BLACK
        ? 'rgba(255,255,255,0.08)'
        : 'rgba(112,99,79,0.35)';
      svg += `<circle cx="${pointX(idx)}" cy="${pointY(idx)}" r="${cell * 0.44}" fill="${fill}" stroke="${stroke}" stroke-width="0.8"/>`;
    });

    const playedMove = position.playedMove;
    const hasPlayedMove = Number.isInteger(playedMove) && playedMove >= 0 && position.board[playedMove] === Go.EMPTY;

    const pointCandidates = !isFinal && analysis
      ? analysis.candidates.filter((candidate) => !candidate.pass).slice(0, 3)
      : [];

    const playedInCandidates = pointCandidates.some((c) => c.idx === playedMove);

    if (hasPlayedMove && !playedInCandidates) {
      svg += `<circle cx="${pointX(playedMove)}" cy="${pointY(playedMove)}" r="${cell * 0.4}" fill="none" stroke="#b1482e" stroke-width="2" stroke-dasharray="4 3"/>`;
    }

    pointCandidates.forEach((candidate, rank) => {
      const isPlayed = candidate.idx === playedMove;
      const color = REVIEW_RANK_COLORS[rank] || REVIEW_RANK_COLORS[2];
      const x = pointX(candidate.idx);
      const y = pointY(candidate.idx);
      if (isPlayed) {
        svg += `<circle cx="${x}" cy="${y}" r="${cell * 0.42}" fill="none" stroke="#b1482e" stroke-width="2.2" stroke-dasharray="4 3"/>`;
      }
      svg += `<circle cx="${x}" cy="${y}" r="${cell * 0.31}" fill="rgba(255,252,245,0.88)" stroke="${color}" stroke-width="2.4"/>`;
      svg += `<text x="${x}" y="${y + 3.5}" text-anchor="middle" font-size="${Math.max(9, cell * 0.2)}" font-weight="600" fill="${color}">${rank + 1}</text>`;
    });

    els.reviewBoardSvg.innerHTML = svg;

    if (!analysis) {
      els.reviewBoardNote.textContent = '这个局面正在分析中…';
      return;
    }

    if (isFinal) {
      els.reviewBoardNote.textContent = '终局局面 · 不再给出下一手推荐';
      return;
    }

    const passCandidate = analysis.candidates.find((candidate) => candidate.pass);
    let note = '';
    if (pointCandidates.length > 0) {
      note = `推荐 ${pointCandidates
        .map((candidate, rank) => `${rank + 1}. ${Go.pointLabel(candidate.idx, size)} ${percentText(candidate.winRate)}`)
        .join(' · ')}`;
    } else {
      note = '终局局面';
    }

    if (passCandidate && passCandidate.winRate >= 0.5) {
      note += ` · 停一手 ${percentText(passCandidate.winRate)}`;
    }

    if (Number.isInteger(playedMove)) {
      if (playedMove === -1) {
        note += ' · 实战停一手';
      } else {
        const label = Go.pointLabel(playedMove, size);
        note += ` · 实战 ${label}`;
        if (analysis.playedRank) note += `（第 ${analysis.playedRank} 选）`;
      }
    }

    els.reviewBoardNote.textContent = note;
  }

  function blackWinRateAt(archive, index) {
    const result = archive.analysisResults[index];
    const position = archive.reviewPositions[index];
    if (!result || !position) return null;

    let blackRate = position.toMove === Go.BLACK ? result.bestRate : 1 - result.bestRate;

    if (index === archive.reviewPositions.length - 1 && archive.result.reason === 'resign') {
      blackRate = archive.result.winner === Go.BLACK ? 1 : 0;
    }

    return Math.max(0, Math.min(1, blackRate));
  }

  function renderReviewChart(archive) {
    const positions = archive.reviewPositions || [];
    const total = positions.length;
    const width = 620;
    const height = 250;
    const padLeft = 48;
    const padRight = 18;
    const padTop = 18;
    const padBottom = 34;
    const plotWidth = width - padLeft - padRight;
    const plotHeight = height - padTop - padBottom;

    const xFor = (index) => (
      total <= 1
        ? padLeft + plotWidth / 2
        : padLeft + (index / (total - 1)) * plotWidth
    );
    const yFor = (rate) => padTop + (1 - rate) * plotHeight;

    const points = [];
    for (let index = 0; index < total; index += 1) {
      const rate = blackWinRateAt(archive, index);
      if (rate !== null) points.push({ index, rate });
    }

    const segments = [];
    let segment = [];
    let expected = 0;
    for (const point of points) {
      if (point.index !== expected && segment.length > 0) {
        segments.push(segment);
        segment = [];
      }
      segment.push(point);
      expected = point.index + 1;
    }
    if (segment.length > 0) segments.push(segment);

    let svg = `
      <defs>
        <linearGradient id="reviewWinArea" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="rgba(30,42,35,0.22)"/>
          <stop offset="1" stop-color="rgba(30,42,35,0.01)"/>
        </linearGradient>
      </defs>`;

    for (const value of [0, 0.25, 0.5, 0.75, 1]) {
      const y = yFor(value);
      const isMid = value === 0.5;
      svg += `<line x1="${padLeft}" y1="${y}" x2="${width - padRight}" y2="${y}" stroke="${isMid ? 'rgba(177,72,46,0.32)' : 'rgba(58,72,60,0.12)'}" stroke-width="1" ${isMid ? 'stroke-dasharray="4 4"' : ''}/>`;
      svg += `<text x="${padLeft - 9}" y="${y + 3.5}" text-anchor="end" font-size="9" fill="#8b9188">${Math.round(value * 100)}%</text>`;
    }

    const tickStep = Math.max(1, Math.ceil(Math.max(1, total - 1) / 6));
    const ticks = new Set([0, total - 1]);
    for (let index = 0; index < total; index += tickStep) ticks.add(index);

    for (const index of Array.from(ticks).sort((a, b) => a - b)) {
      const x = xFor(index);
      svg += `<line x1="${x}" y1="${height - padBottom}" x2="${x}" y2="${height - padBottom + 4}" stroke="rgba(58,72,60,0.2)"/>`;
      svg += `<text x="${x}" y="${height - padBottom + 16}" text-anchor="middle" font-size="9" fill="#8b9188">${index}</text>`;
    }
    svg += `<text x="${width - padRight}" y="${height - 5}" text-anchor="end" font-size="9" fill="#8b9188">手数</text>`;

    for (const current of segments) {
      if (current.length === 0) continue;
      const linePath = current
        .map((point, index) => `${index === 0 ? 'M' : 'L'}${xFor(point.index).toFixed(1)},${yFor(point.rate).toFixed(1)}`)
        .join(' ');
      if (current.length > 1) {
        const areaPath = `${linePath} L${xFor(current[current.length - 1].index).toFixed(1)},${height - padBottom} L${xFor(current[0].index).toFixed(1)},${height - padBottom} Z`;
        svg += `<path d="${areaPath}" fill="url(#reviewWinArea)"/>`;
        svg += `<path d="${linePath}" fill="none" stroke="#1e2a23" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>`;
      }
    }

    const selected = state.review.selected;
    if (selected >= 0 && selected < total) {
      const x = xFor(selected);
      svg += `<line x1="${x}" y1="${padTop}" x2="${x}" y2="${height - padBottom}" stroke="rgba(177,72,46,0.45)" stroke-width="1" stroke-dasharray="3 4"/>`;
    }

    for (const point of points) {
      const x = xFor(point.index);
      const y = yFor(point.rate);
      const active = point.index === selected;
      if (active) {
        svg += `<circle cx="${x}" cy="${y}" r="7" fill="none" stroke="#b1482e" stroke-width="1.6"/>`;
      }
      svg += `<circle cx="${x}" cy="${y}" r="${active ? 4 : 3.1}" fill="${active ? '#b1482e' : '#1e2a23'}" stroke="#fbf7ee" stroke-width="1.2"><title>第 ${point.index} 手后 · 黑棋胜率 ${percentText(point.rate)}</title></circle>`;
      svg += `<circle class="review-chart-hit" data-index="${point.index}" cx="${x}" cy="${y}" r="9" fill="transparent" tabindex="0" role="button" aria-label="查看第 ${point.index} 手之后的局面"/>`;
    }

    els.reviewChart.innerHTML = svg;
  }

  function renderReviewTable(archive) {
    const positions = archive.reviewPositions || [];
    const results = archive.analysisResults || [];
    const rows = [];

    for (let index = 0; index < archive.history.length; index += 1) {
      const entry = archive.history[index];
      const analysis = results[index];
      const selected = state.review.selected === index;
      const stoneColor = entry.color === Go.BLACK ? 'black' : 'white';
      const moveLabel = entry.pass
        ? '停一手'
        : Go.pointLabel(entry.idx, archive.size);

      let rateCell = '<span class="review-pending">分析中…</span>';
      let topCell = '';
      let rankCell = '—';

      if (analysis) {
        rateCell = analysis.playedRate === null
          ? '—'
          : `<strong>${percentText(analysis.playedRate)}</strong>`;

        const pointCandidates = analysis.candidates
          .filter((candidate) => !candidate.pass)
          .slice(0, 3);
        const passCandidate = analysis.candidates.find((candidate) => candidate.pass);

        if (pointCandidates.length > 0) {
          topCell = pointCandidates
            .map((candidate, rank) => (
              `<span class="review-point rank-${rank + 1}">`
              + `${Go.pointLabel(candidate.idx, archive.size)} <em>${percentText(candidate.winRate)}</em>`
              + '</span>'
            ))
            .join('');
        } else {
          topCell = '<span class="review-pending">终局</span>';
        }

        if (passCandidate && passCandidate.winRate >= 0.5) {
          topCell += `<span class="review-point rank-pass">停一手 <em>${percentText(passCandidate.winRate)}</em></span>`;
        }

        if (analysis.playedRank !== null) {
          rankCell = `第 ${analysis.playedRank} <span>/ ${analysis.evaluated}</span>`;
        }
      }

      rows.push(`
        <tr data-index="${index}" class="${selected ? 'is-selected' : ''}">
          <td><span class="review-move-no">${entry.moveNumber}</span></td>
          <td>
            <span class="review-move">
              <i class="review-stone ${stoneColor}" aria-hidden="true"></i>
              <span>${moveLabel}</span>
            </span>
          </td>
          <td class="review-rate">${rateCell}</td>
          <td><div class="review-points">${topCell}</div></td>
          <td class="review-rank">${rankCell}</td>
        </tr>
      `);
    }

    if (archive.history.length > 0) {
      const finalIndex = archive.history.length;
      const finalSelected = state.review.selected === finalIndex;
      let finalOutcome = '终局';
      if (archive.result.winner === Go.EMPTY) {
        finalOutcome = '双方和棋';
      } else if (archive.result.reason === 'resign') {
        finalOutcome = `${colorName(archive.result.winner)}中盘胜`;
      } else {
        finalOutcome = `${colorName(archive.result.winner)}胜 ${archive.result.judge.margin.toFixed(1)} 目`;
      }

      rows.push(`
        <tr data-index="${finalIndex}" class="review-final-row ${finalSelected ? 'is-selected' : ''}">
          <td><span class="review-move-no">终</span></td>
          <td>
            <span class="review-move">
              <span>终局盘面</span>
            </span>
          </td>
          <td class="review-rate"><strong>${finalOutcome}</strong></td>
          <td colspan="2"><div class="review-points"><span class="review-point rank-1">终局数子完毕</span></div></td>
        </tr>
      `);
    }

    els.reviewTableBody.innerHTML = rows.join('');
  }

  function selectReviewPosition(index) {
    const archive = activeArchive();
    if (!archive) return;

    const max = Math.max(0, (archive.reviewPositions || []).length - 1);
    state.review.selected = Math.max(0, Math.min(max, index));
    archive.analysisSelected = state.review.selected;
    renderReview();
  }

  /* -----------------------------------------------------------------------
   * UI rendering
   * --------------------------------------------------------------------- */

  function setStoneClass(element, color, baseClass) {
    element.className = `${baseClass} ${color === Go.BLACK ? 'black' : 'white'}`;
  }

  function updateSetupUi() {
    els.sizeControl.querySelectorAll('[data-size]').forEach((button) => {
      const active = Number(button.dataset.size) === state.selectedSize;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    els.colorControl.querySelectorAll('[data-color]').forEach((button) => {
      const active = Number(button.dataset.color) === state.selectedColor;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });

    els.sizeHint.textContent = `${state.selectedSize} × ${state.selectedSize}`;

    const changed = state.selectedSize !== state.size || state.selectedColor !== state.humanColor;
    els.newGameBtn.querySelector('span').textContent = changed ? '应用设置，重新开局' : '开始新对局';
  }

  function updateUi() {
    const isOver = state.phase === 'over';
    const isThinking = state.phase === 'ai';
    const humanTurn = !isOver && !isThinking && state.toMove === state.humanColor;
    const displayColor = isOver && state.result ? state.result.winner : state.toMove;
    const humanColorName = colorName(state.humanColor);
    const sideColorName = colorName(displayColor);

    els.boardKicker.textContent = `${CHINESE_NUMERALS[state.size]}路棋盘`;
    els.boardTitle.textContent = `${state.size} × ${state.size} 对局`;
    setStoneClass(els.turnPillStone, state.humanColor, 'mini-stone');
    els.turnPillText.textContent = `你执${humanColorName}`;

    els.gameMeta.textContent = `中国规则 · 白贴 ${KOMI} 目`;
    setStoneClass(els.statusStone, displayColor, 'status-stone');

    if (isOver) {
      const humanWon = state.result && state.result.winner === state.humanColor;
      els.statusText.textContent = humanWon ? '你获胜' : 'AI 获胜';
      els.statusSide.textContent = '终局';
    } else if (isThinking) {
      els.statusText.textContent = 'AI 思考中…';
      els.statusSide.textContent = `${sideColorName}棋`;
    } else if (humanTurn) {
      els.statusText.textContent = '轮到你落子';
      els.statusSide.textContent = `${sideColorName}棋`;
    } else {
      els.statusText.textContent = '等待 AI 落子';
      els.statusSide.textContent = `${sideColorName}棋`;
    }

    els.moveMetric.textContent = String(state.moveNumber);
    els.blackCapMetric.textContent = String(state.captures[Go.BLACK]);
    els.whiteCapMetric.textContent = String(state.captures[Go.WHITE]);

    els.passBtn.disabled = !humanTurn;
    els.resignBtn.disabled = isOver;
    els.boardFrame.classList.toggle('is-disabled', !humanTurn);

    if (isOver) {
      els.boardHint.textContent = '对局已结束';
    } else if (isThinking) {
      els.boardHint.textContent = 'AI 思考中';
    } else if (humanTurn) {
      els.boardHint.textContent = '点击交叉点落子';
    } else {
      els.boardHint.textContent = '等待 AI 落子';
    }

    if (state.lastAction) {
      if (state.lastAction.type === 'move') {
        const action = state.lastAction;
        els.lastMoveInfo.textContent =
          `第 ${state.moveNumber} 手 · ${colorName(action.color)}棋 ${Go.pointLabel(action.idx, state.size)}${action.captured ? ` · 提 ${action.captured} 子` : ''}`;
      } else {
        els.lastMoveInfo.textContent = `第 ${state.moveNumber} 手 · ${colorName(state.lastAction.color)}棋停一手`;
      }
    } else {
      els.lastMoveInfo.textContent = '静候第一手';
    }

    els.showResultBtn.hidden = !(isOver && els.resultLayer.hidden);
    els.reviewChipBtn.hidden = !isOver;
    els.canvas.setAttribute('aria-label', `${state.size}乘${state.size}围棋棋盘`);

    updateSetupUi();
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.hidden = false;
    if (state.toastTimer) window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      els.toast.hidden = true;
      state.toastTimer = null;
    }, 1750);
  }

  function announce(message) {
    els.liveRegion.textContent = '';
    window.setTimeout(() => {
      els.liveRegion.textContent = message;
    }, 20);
  }

  /* -----------------------------------------------------------------------
   * Canvas rendering
   * --------------------------------------------------------------------- */

  function resizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !state.board) return;

    const cssSize = Math.round(rect.width);
    const dpr = Math.min(window.devicePixelRatio || 1, CANVAS_MAX_DPR);
    const pixelSize = Math.max(1, Math.round(cssSize * dpr));

    view.cssSize = cssSize;
    view.dpr = dpr;
    view.pad = Math.max(30, cssSize * 0.135);
    view.cell = (cssSize - view.pad * 2) / (state.size - 1);

    canvas.width = pixelSize;
    canvas.height = pixelSize;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawBoard();
  }

  function drawBoard() {
    if (!state.board || !view.cssSize) return;

    const size = view.cssSize;
    const n = state.size;
    const gridStart = view.pad;
    const gridEnd = view.pad + view.cell * (n - 1);

    ctx.clearRect(0, 0, size, size);

    // 木盘底色
    const wood = ctx.createLinearGradient(0, 0, size, size);
    wood.addColorStop(0, '#ddb277');
    wood.addColorStop(0.44, '#d2a263');
    wood.addColorStop(1, '#c18d4f');
    ctx.fillStyle = wood;
    ctx.fillRect(0, 0, size, size);

    const sheen = ctx.createRadialGradient(
      size * 0.2, size * 0.13, size * 0.02,
      size * 0.23, size * 0.19, size * 0.78,
    );
    sheen.addColorStop(0, 'rgba(255, 245, 219, 0.35)');
    sheen.addColorStop(0.46, 'rgba(255, 243, 214, 0.06)');
    sheen.addColorStop(1, 'rgba(77, 44, 16, 0.13)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, size, size);

    drawGrain(size);
    drawGrid(gridStart, gridEnd);
    drawStarPoints();
    drawCoordinates();

    let needsAnimationFrame = false;
    let lastMoveScale = 1;
    for (let idx = 0; idx < state.board.length; idx += 1) {
      const color = state.board[idx];
      if (color === Go.EMPTY) continue;

      const x = gridStart + (idx % n) * view.cell;
      const y = gridStart + Math.floor(idx / n) * view.cell;
      let scale = 1;

      if (state.stoneAnimation && state.stoneAnimation.idx === idx) {
        const elapsed = performance.now() - state.stoneAnimation.startedAt;
        const t = Math.min(1, elapsed / 190);
        scale = 0.55 + 0.45 * easeOutBack(t);
        if (t >= 1) {
          state.stoneAnimation = null;
        } else {
          needsAnimationFrame = true;
        }
      }

      if (idx === state.lastMove) {
        lastMoveScale = scale;
      }

      drawStone(x, y, view.cell * 0.42, color, { scale });
    }

    if (state.lastMove >= 0 && state.board[state.lastMove] !== Go.EMPTY) {
      const x = gridStart + (state.lastMove % n) * view.cell;
      const y = gridStart + Math.floor(state.lastMove / n) * view.cell;
      drawLastMarker(x, y, lastMoveScale);
    }

    if (state.hover !== null && canHumanPlay() && state.board[state.hover] === Go.EMPTY) {
      const x = gridStart + (state.hover % n) * view.cell;
      const y = gridStart + Math.floor(state.hover / n) * view.cell;
      drawStone(x, y, view.cell * 0.42, state.humanColor, { alpha: 0.34, ghost: true });
    }

    if (needsAnimationFrame) {
      if (state.drawFrame) window.cancelAnimationFrame(state.drawFrame);
      state.drawFrame = window.requestAnimationFrame(() => {
        state.drawFrame = null;
        drawBoard();
      });
    }
  }

  function drawGrain(size) {
    ctx.save();
    ctx.globalAlpha = 0.5;
    for (let i = 0; i < 11; i += 1) {
      const baseY = (i / 11) * size + 8;
      ctx.beginPath();
      for (let x = -10; x <= size + 10; x += 16) {
        const y = baseY
          + Math.sin(x * 0.018 + i * 1.31) * 3.2
          + Math.sin(x * 0.005 + i) * 2.1;
        if (x <= -10) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = i % 3 === 0
        ? 'rgba(93, 57, 24, 0.075)'
        : 'rgba(255, 243, 217, 0.07)';
      ctx.lineWidth = i % 3 === 0 ? 1.1 : 0.8;
      ctx.stroke();
    }
    ctx.restore();

    const vignette = ctx.createRadialGradient(
      size * 0.5, size * 0.46, size * 0.16,
      size * 0.5, size * 0.5, size * 0.74,
    );
    vignette.addColorStop(0, 'rgba(75, 43, 16, 0)');
    vignette.addColorStop(1, 'rgba(70, 40, 15, 0.16)');
    ctx.fillStyle = vignette;
    ctx.fillRect(0, 0, size, size);
  }

  function drawGrid(start, end) {
    const n = state.size;
    ctx.save();
    ctx.strokeStyle = 'rgba(65, 42, 19, 0.7)';
    ctx.lineWidth = Math.max(0.85, view.cssSize * 0.0016);
    ctx.beginPath();
    for (let i = 0; i < n; i += 1) {
      const position = start + i * view.cell;
      ctx.moveTo(start, position);
      ctx.lineTo(end, position);
      ctx.moveTo(position, start);
      ctx.lineTo(position, end);
    }
    ctx.stroke();

    ctx.strokeStyle = 'rgba(65, 42, 19, 0.25)';
    ctx.lineWidth = Math.max(0.8, view.cssSize * 0.001);
    ctx.strokeRect(start, start, end - start, end - start);
    ctx.restore();
  }

  function starPoints() {
    if (state.size === 5) {
      return [[2, 2], [1, 1], [1, 3], [3, 1], [3, 3]];
    }
    return [[2, 2], [2, 3], [3, 2], [3, 3]];
  }

  function drawStarPoints() {
    const radius = Math.max(1.8, Math.min(4.6, view.cell * 0.05));
    ctx.save();
    ctx.fillStyle = 'rgba(60, 38, 17, 0.78)';
    for (const [x, y] of starPoints()) {
      ctx.beginPath();
      ctx.arc(view.pad + x * view.cell, view.pad + y * view.cell, radius, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawCoordinates() {
    const n = state.size;
    const fontSize = Math.max(8.5, Math.min(12, view.cssSize * 0.017));
    ctx.save();
    ctx.fillStyle = 'rgba(71, 45, 20, 0.55)';
    ctx.font = `500 ${fontSize}px "Avenir Next", "PingFang SC", "Microsoft YaHei", sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let i = 0; i < n; i += 1) {
      const x = view.pad + i * view.cell;
      ctx.fillText(Go.LETTERS[i], x, view.cssSize - view.pad * 0.31);
    }

    for (let i = 0; i < n; i += 1) {
      const y = view.pad + i * view.cell;
      ctx.fillText(String(n - i), view.pad * 0.31, y);
    }
    ctx.restore();
  }

  function drawStone(x, y, radius, color, options = {}) {
    const { alpha = 1, scale = 1, ghost = false } = options;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.translate(x, y);
    ctx.scale(scale, scale);

    if (!ghost) {
      ctx.shadowColor = color === Go.BLACK
        ? 'rgba(22, 16, 9, 0.4)'
        : 'rgba(64, 44, 21, 0.31)';
      ctx.shadowBlur = radius * 0.42;
      ctx.shadowOffsetY = radius * 0.18;
    }

    const gradient = ctx.createRadialGradient(
      -radius * 0.34, -radius * 0.4, radius * 0.06,
      0, 0, radius * 1.03,
    );

    if (color === Go.BLACK) {
      gradient.addColorStop(0, '#81847b');
      gradient.addColorStop(0.22, '#4a4c47');
      gradient.addColorStop(0.62, '#22241f');
      gradient.addColorStop(0.9, '#0c0d0b');
      gradient.addColorStop(1, '#030403');
    } else {
      gradient.addColorStop(0, '#ffffff');
      gradient.addColorStop(0.3, '#fbf7ef');
      gradient.addColorStop(0.72, '#e7dfd2');
      gradient.addColorStop(0.94, '#c9c0b1');
      gradient.addColorStop(1, '#b3a997');
    }

    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, TAU);
    ctx.fillStyle = gradient;
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.lineWidth = Math.max(0.6, radius * 0.035);
    ctx.strokeStyle = color === Go.BLACK
      ? 'rgba(255, 255, 255, 0.08)'
      : 'rgba(112, 99, 79, 0.38)';
    ctx.stroke();

    if (!ghost) {
      const highlight = ctx.createRadialGradient(
        -radius * 0.38, -radius * 0.44, 0,
        -radius * 0.35, -radius * 0.4, radius * 0.65,
      );
      highlight.addColorStop(0, color === Go.BLACK
        ? 'rgba(255, 255, 255, 0.17)'
        : 'rgba(255, 255, 255, 0.6)');
      highlight.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.beginPath();
      ctx.arc(-radius * 0.24, -radius * 0.28, radius * 0.48, 0, TAU);
      ctx.fillStyle = highlight;
      ctx.fill();
    }

    ctx.restore();
  }

  function drawLastMarker(x, y, scale = 1) {
    const radius = Math.max(2.2, view.cell * 0.075) * scale;
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, TAU);
    ctx.fillStyle = '#b54930';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(x, y, radius * 0.45, 0, TAU);
    ctx.fillStyle = 'rgba(255, 246, 230, 0.78)';
    ctx.fill();
    ctx.restore();
  }

  function easeOutBack(t) {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  }

  /* -----------------------------------------------------------------------
   * Event wiring
   * --------------------------------------------------------------------- */

  function bindEvents() {
    els.sizeControl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-size]');
      if (!button) return;
      state.selectedSize = Number(button.dataset.size) === 6 ? 6 : 5;
      updateSetupUi();
    });

    els.colorControl.addEventListener('click', (event) => {
      const button = event.target.closest('[data-color]');
      if (!button) return;
      state.selectedColor = Number(button.dataset.color) === Go.WHITE ? Go.WHITE : Go.BLACK;
      updateSetupUi();
    });

    els.newGameBtn.addEventListener('click', startNewGame);
    els.againBtn.addEventListener('click', startNewGame);
    els.passBtn.addEventListener('click', handlePass);
    els.resignBtn.addEventListener('click', handleResign);
    els.reviewBtn.addEventListener('click', hideResult);
    els.showResultBtn.addEventListener('click', showResult);

    els.reviewGameBtn.addEventListener('click', () => openReview());
    els.reviewChipBtn.addEventListener('click', () => openReview());
    els.historyReviewBtn.addEventListener('click', () => openReview());
    els.reviewCloseBtn.addEventListener('click', closeReview);
    els.reviewRefreshBtn.addEventListener('click', () => runReviewAnalysis(true));
    els.reviewGameSelect.addEventListener('change', (event) => {
      setReviewArchive(Number(event.target.value));
    });

    els.reviewTableBody.addEventListener('click', (event) => {
      const row = event.target.closest('tr[data-index]');
      if (!row) return;
      selectReviewPosition(Number(row.dataset.index));
    });

    els.reviewChart.addEventListener('click', (event) => {
      const hit = event.target.closest('[data-index]');
      if (hit) {
        selectReviewPosition(Number(hit.getAttribute('data-index')));
        return;
      }

      const archive = activeArchive();
      if (!archive || !archive.reviewPositions) return;
      const total = archive.reviewPositions.length;
      if (total <= 1) return;

      const rect = els.reviewChart.getBoundingClientRect();
      if (!rect.width) return;
      const chartX = ((event.clientX - rect.left) / rect.width) * 620;
      const ratio = (chartX - 48) / (620 - 48 - 18);
      selectReviewPosition(Math.round(ratio * (total - 1)));
    });

    els.reviewChart.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      const hit = event.target.closest('[data-index]');
      if (!hit) return;
      event.preventDefault();
      selectReviewPosition(Number(hit.getAttribute('data-index')));
    });

    canvas.addEventListener('pointerdown', handleCanvasPointerDown);
    canvas.addEventListener('pointermove', handlePointerMove);
    canvas.addEventListener('pointerleave', clearHover);
    canvas.addEventListener('pointercancel', clearHover);

    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (!els.resultLayer.hidden) {
        hideResult();
      } else if (state.review.open) {
        closeReview();
      }
    });
  }

  function init() {
    if (!Go || !GoAI) {
      console.error('围棋引擎加载失败。');
      return;
    }

    canvas.setAttribute('tabindex', '0');
    els.boardFrame.tabIndex = -1;
    bindEvents();

    if (typeof ResizeObserver !== 'undefined') {
      const observer = new ResizeObserver(() => resizeCanvas());
      observer.observe(canvas);
    } else {
      window.addEventListener('resize', resizeCanvas);
    }

    startNewGame();
    window.requestAnimationFrame(resizeCanvas);
  }

  init();
})();
