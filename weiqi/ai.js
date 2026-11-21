/*
 * 小棋盘围棋 AI
 * FastBoard 增量链气引擎 + MoGo 3×3 局部棋型 + PUCT + First-Play RAVE + 目数引导 MCTS。
 *
 * 每次搜索都会将变化推演至终局或双停，支持 8 重棋盘对称性归约与高精度复盘分析。
 */
(function (root) {
  'use strict';

  const Go = root.Go;
  if (!Go) throw new Error('engine.js 需要先于 ai.js 加载');

  const MIN_LOOKAHEAD_PLIES = 18;
  const DEFAULT_TIME_LIMIT = 2100;
  const MAX_TIME_LIMIT = 5000;
  const EXPAND_THRESHOLD = 2;

  const now = typeof performance !== 'undefined' && performance.now
    ? () => performance.now()
    : () => Date.now();

  /* -----------------------------------------------------------------------
   * 位运算与快速 PRNG 工具
   * --------------------------------------------------------------------- */

  function popcount32(x) {
    x -= (x >>> 1) & 0x55555555;
    x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
    return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
  }

  function popcountPair(lo, hi) {
    return popcount32(lo) + popcount32(hi);
  }

  function isSingleBitPair(lo, hi) {
    return (lo !== 0 && hi === 0 && (lo & (lo - 1)) === 0)
      || (hi !== 0 && lo === 0 && (hi & (hi - 1)) === 0);
  }

  function singleBitIndex(lo, hi) {
    if (lo !== 0) return 31 - Math.clz32(lo);
    return 32 + (31 - Math.clz32(hi));
  }

  function nextRand(ctx) {
    let x = ctx.rng | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    ctx.rng = x;
    return (x >>> 0) / 4294967296;
  }

  function nextRandInt(ctx, max) {
    let x = ctx.rng | 0;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    ctx.rng = x;
    return Math.floor(((x >>> 0) * max) / 4294967296);
  }

  /* -----------------------------------------------------------------------
   * 预计算 MoGo 3×3 局部棋型表（65536 项查表）
   * ring 顺序（顺时针）：[N(0), NE(1), E(2), SE(3), S(4), SW(5), W(6), NW(7)]
   * 2-bit 编码：0=空, 1=己, 2=敌, 3=界外
   * --------------------------------------------------------------------- */

  const CHAR_VALS = {
    '.': [0],
    'X': [1],
    'O': [2],
    '#': [3],
    '?': [0, 1, 2, 3],
    'B': [0, 1, 2],
    'E': [0, 1],
    'x': [0, 2, 3],
    'o': [0, 1, 3],
  };

  const PATTERN_TABLE = (function buildPatternTable() {
    const table = new Uint8Array(65536);

    // 行列顺序：NW(7), N(0), NE(1), W(6), E(2), SW(5), S(4), SE(3)
    const templates = [
      // Hane 扳 / 夹
      ['X', 'O', 'X', '.', '.', '?', '?', '?'],
      ['X', 'O', '.', '.', '.', '?', '.', '?'],
      ['X', 'O', '?', 'X', '.', '?', '.', '?'],
      ['X', 'O', 'O', '.', '.', '?', '.', '?'],
      // Cut 断 / 挖
      ['X', 'O', '?', 'O', '.', '?', '?', '?'],
      ['?', 'O', '?', 'X', '.', '?', 'O', '?'],
      // Connect 连 / 虎口 / 竹节
      ['?', 'X', '?', 'O', '.', '?', 'X', '?'],
      ['X', 'O', '?', '.', 'X', '?', '.', '?'],
      // 边线阻挡 / 扳 / 尖
      ['#', '#', '#', 'X', 'O', '?', '?', '?'],
      ['#', '#', '#', 'O', '.', 'X', '?', '?'],
      ['#', '#', '#', '.', '.', 'X', 'O', '?'],
      ['#', '#', '#', 'X', '.', 'O', '?', '?'],
    ];

    function setSymmetries(vals) {
      for (let swap = 0; swap < 2; swap += 1) {
        const s0 = swap === 0 ? vals : vals.map((v) => (v === 1 ? 2 : v === 2 ? 1 : v));
        // 4 旋转 + 4 翻转
        for (let flip = 0; flip < 2; flip += 1) {
          const base = flip === 0
            ? s0
            : [s0[0], s0[7], s0[6], s0[5], s0[4], s0[3], s0[2], s0[1]];
          for (let rot = 0; rot < 4; rot += 1) {
            const shift = rot * 2;
            let key = 0;
            for (let i = 0; i < 8; i += 1) {
              key |= base[(i + shift) & 7] << (i * 2);
            }
            table[key] = 1;
          }
        }
      }
    }

    for (let t = 0; t < templates.length; t += 1) {
      const tpl = templates[t];
      // 将 [NW, N, NE, W, E, SW, S, SE] 映射到 ring [N, NE, E, SE, S, SW, W, NW]
      const ringTpl = [tpl[1], tpl[2], tpl[4], tpl[7], tpl[6], tpl[5], tpl[3], tpl[0]];
      const domains = ringTpl.map((ch) => CHAR_VALS[ch]);
      const cur = new Array(8);

      const expand = (depth) => {
        if (depth === 8) {
          setSymmetries(cur);
          return;
        }
        const dom = domains[depth];
        for (let i = 0; i < dom.length; i += 1) {
          cur[depth] = dom[i];
          expand(depth + 1);
        }
      };
      expand(0);
    }

    return table;
  })();

  /* -----------------------------------------------------------------------
   * 零分配增量 FastBoard 引擎
   * --------------------------------------------------------------------- */

  const _fHeads = new Int8Array(4);
  const _eHeads = new Int8Array(4);
  const _inspectOut = {
    legal: false,
    capStones: 0,
    newLibs: 0,
    newStones: 0,
    savesAtariStones: 0,
    putsEnemyInAtari: false,
    atariEnemyStones: 0,
    reducesEnemyTo2: false,
    connectsFriendly: false,
    cutsEnemy: false,
    enemyOrthCount: 0,
    emptyOrthCount: 0,
    minFriendlyLibs: 99,
    fCount: 0,
  };

  function createFastBoard(n) {
    return {
      n,
      board: new Uint8Array(n),
      head: new Int8Array(n),
      next: new Int8Array(n),
      chainSize: new Uint8Array(n),
      libLo: new Int32Array(n),
      libHi: new Int32Array(n),
      emptyList: new Uint8Array(n),
      emptyPos: new Int8Array(n),
      emptyCount: 0,
      ko: -1,
      hashLo: 0,
      hashHi: 0,
    };
  }

  function copyFastBoard(dst, src) {
    dst.board.set(src.board);
    dst.head.set(src.head);
    dst.next.set(src.next);
    dst.chainSize.set(src.chainSize);
    dst.libLo.set(src.libLo);
    dst.libHi.set(src.libHi);
    dst.emptyList.set(src.emptyList);
    dst.emptyPos.set(src.emptyPos);
    dst.emptyCount = src.emptyCount;
    dst.ko = src.ko;
    dst.hashLo = src.hashLo;
    dst.hashHi = src.hashHi;
  }

  function initFastBoard(fb, boardArr, geo, ko) {
    const n = geo.n;
    fb.head.fill(-1);
    fb.next.fill(-1);
    fb.chainSize.fill(0);
    fb.libLo.fill(0);
    fb.libHi.fill(0);
    fb.emptyPos.fill(-1);
    fb.emptyCount = 0;
    fb.ko = Number.isInteger(ko) ? ko : -1;
    fb.hashLo = 0;
    fb.hashHi = 0;

    for (let i = 0; i < n; i += 1) {
      const c = boardArr[i];
      fb.board[i] = c;
      if (c === 0) {
        fb.emptyPos[i] = fb.emptyCount;
        fb.emptyList[fb.emptyCount] = i;
        fb.emptyCount += 1;
      } else {
        const zOff = c * n + i;
        fb.hashLo ^= geo.zobristLo[zOff];
        fb.hashHi ^= geo.zobristHi[zOff];
      }
    }

    const stack = new Uint8Array(n);
    const stones = new Uint8Array(n);
    for (let start = 0; start < n; start += 1) {
      const color = fb.board[start];
      if (color === 0 || fb.head[start] !== -1) continue;

      let sLen = 0;
      let sp = 1;
      stack[0] = start;
      fb.head[start] = start;
      let lLo = 0;
      let lHi = 0;

      while (sp > 0) {
        sp -= 1;
        const p = stack[sp];
        stones[sLen] = p;
        sLen += 1;
        const ns = geo.neighbors[p];
        for (let i = 0; i < ns.length; i += 1) {
          const nb = ns[i];
          const nc = fb.board[nb];
          if (nc === 0) {
            lLo |= geo.bitLo[nb];
            lHi |= geo.bitHi[nb];
          } else if (nc === color && fb.head[nb] === -1) {
            fb.head[nb] = start;
            stack[sp] = nb;
            sp += 1;
          }
        }
      }

      for (let i = 0; i < sLen; i += 1) {
        const cur = stones[i];
        const nxt = stones[i + 1 < sLen ? i + 1 : 0];
        fb.next[cur] = nxt;
      }
      fb.chainSize[start] = sLen;
      fb.libLo[start] = lLo;
      fb.libHi[start] = lHi;
    }
  }

  function isTrueEyeFast(fb, geo, idx, color) {
    if (fb.board[idx] !== 0) return false;
    const ns = geo.neighbors[idx];
    for (let i = 0; i < ns.length; i += 1) {
      const nb = ns[i];
      if (fb.board[nb] !== color) return false;
      const h = fb.head[nb];
      if (isSingleBitPair(fb.libLo[h], fb.libHi[h])) return false;
    }

    const ds = geo.diagonals[idx];
    if (ds.length === 0) return true;
    const opp = color === 1 ? 2 : 1;
    let enemyDiag = 0;
    for (let i = 0; i < ds.length; i += 1) {
      if (fb.board[ds[i]] === opp) enemyDiag += 1;
    }
    return enemyDiag <= (ns.length === 4 ? 1 : 0);
  }

  function inspectMove(fb, geo, idx, color, out) {
    if (fb.board[idx] !== 0 || idx === fb.ko) {
      out.legal = false;
      return out;
    }

    const opp = color === 1 ? 2 : 1;
    const ns = geo.neighbors[idx];
    const bLo = geo.bitLo[idx];
    const bHi = geo.bitHi[idx];
    const notBLo = ~bLo;
    const notBHi = ~bHi;

    let fCount = 0;
    let eCount = 0;
    let ownLibLo = 0;
    let ownLibHi = 0;
    let enemyOrthCount = 0;
    let emptyOrthCount = 0;

    for (let i = 0; i < ns.length; i += 1) {
      const nb = ns[i];
      const c = fb.board[nb];
      if (c === 0) {
        emptyOrthCount += 1;
        ownLibLo |= geo.bitLo[nb];
        ownLibHi |= geo.bitHi[nb];
      } else if (c === color) {
        const h = fb.head[nb];
        let dup = false;
        for (let j = 0; j < fCount; j += 1) {
          if (_fHeads[j] === h) { dup = true; break; }
        }
        if (!dup) {
          _fHeads[fCount] = h;
          fCount += 1;
        }
      } else {
        enemyOrthCount += 1;
        const h = fb.head[nb];
        let dup = false;
        for (let j = 0; j < eCount; j += 1) {
          if (_eHeads[j] === h) { dup = true; break; }
        }
        if (!dup) {
          _eHeads[eCount] = h;
          eCount += 1;
        }
      }
    }

    let newLibLo = ownLibLo;
    let newLibHi = ownLibHi;
    let newStones = 1;
    let savesAtariStones = 0;
    let minFriendlyLibs = 99;

    for (let i = 0; i < fCount; i += 1) {
      const fh = _fHeads[i];
      const fullLibs = popcountPair(fb.libLo[fh], fb.libHi[fh]);
      if (fullLibs < minFriendlyLibs) minFriendlyLibs = fullLibs;
      const flLo = fb.libLo[fh] & notBLo;
      const flHi = fb.libHi[fh] & notBHi;
      if ((flLo | flHi) === 0) {
        savesAtariStones += fb.chainSize[fh];
      }
      newLibLo |= flLo;
      newLibHi |= flHi;
      newStones += fb.chainSize[fh];
    }

    let capStones = 0;
    let putsEnemyInAtari = false;
    let atariEnemyStones = 0;
    let reducesEnemyTo2 = false;

    for (let i = 0; i < eCount; i += 1) {
      const eh = _eHeads[i];
      const elLo = fb.libLo[eh] & notBLo;
      const elHi = fb.libHi[eh] & notBHi;
      const eLibs = popcountPair(elLo, elHi);
      if (eLibs === 0) {
        capStones += fb.chainSize[eh];
        let cur = eh;
        do {
          const sns = geo.neighbors[cur];
          let touchesMerged = false;
          for (let k = 0; k < sns.length; k += 1) {
            const sn = sns[k];
            if (sn === idx) {
              touchesMerged = true;
              break;
            }
            if (fb.board[sn] === color) {
              const sh = fb.head[sn];
              for (let j = 0; j < fCount; j += 1) {
                if (_fHeads[j] === sh) {
                  touchesMerged = true;
                  break;
                }
              }
              if (touchesMerged) break;
            }
          }
          if (touchesMerged) {
            newLibLo |= geo.bitLo[cur];
            newLibHi |= geo.bitHi[cur];
          }
          cur = fb.next[cur];
        } while (cur !== eh);
      } else if (eLibs === 1) {
        putsEnemyInAtari = true;
        atariEnemyStones += fb.chainSize[eh];
      } else if (eLibs === 2) {
        reducesEnemyTo2 = true;
      }
    }

    if (capStones === 0 && (newLibLo | newLibHi) === 0) {
      out.legal = false;
      return out;
    }

    out.legal = true;
    out.capStones = capStones;
    out.newLibs = popcountPair(newLibLo, newLibHi);
    out.newStones = newStones;
    out.savesAtariStones = savesAtariStones;
    out.putsEnemyInAtari = putsEnemyInAtari;
    out.atariEnemyStones = atariEnemyStones;
    out.reducesEnemyTo2 = reducesEnemyTo2;
    out.connectsFriendly = fCount >= 2;
    out.cutsEnemy = eCount >= 2;
    out.enemyOrthCount = enemyOrthCount;
    out.emptyOrthCount = emptyOrthCount;
    out.minFriendlyLibs = minFriendlyLibs;
    out.fCount = fCount;
    return out;
  }

  function playFast(fb, geo, idx, color) {
    if (idx < 0 || idx >= geo.n || fb.board[idx] !== 0 || idx === fb.ko) return -1;

    const opp = color === 1 ? 2 : 1;
    const ns = geo.neighbors[idx];
    const bLo = geo.bitLo[idx];
    const bHi = geo.bitHi[idx];
    const notBLo = ~bLo;
    const notBHi = ~bHi;

    let fCount = 0;
    let eCount = 0;
    let ownLibLo = 0;
    let ownLibHi = 0;
    let hasCapture = false;

    for (let i = 0; i < ns.length; i += 1) {
      const nb = ns[i];
      const c = fb.board[nb];
      if (c === 0) {
        ownLibLo |= geo.bitLo[nb];
        ownLibHi |= geo.bitHi[nb];
      } else if (c === color) {
        const h = fb.head[nb];
        let dup = false;
        for (let j = 0; j < fCount; j += 1) {
          if (_fHeads[j] === h) { dup = true; break; }
        }
        if (!dup) {
          _fHeads[fCount] = h;
          fCount += 1;
        }
      } else {
        const h = fb.head[nb];
        let dup = false;
        for (let j = 0; j < eCount; j += 1) {
          if (_eHeads[j] === h) { dup = true; break; }
        }
        if (!dup) {
          _eHeads[eCount] = h;
          eCount += 1;
          if (((fb.libLo[h] & notBLo) | (fb.libHi[h] & notBHi)) === 0) {
            hasCapture = true;
          }
        }
      }
    }

    let mergedLibLo = ownLibLo;
    let mergedLibHi = ownLibHi;
    for (let i = 0; i < fCount; i += 1) {
      const h = _fHeads[i];
      mergedLibLo |= fb.libLo[h] & notBLo;
      mergedLibHi |= fb.libHi[h] & notBHi;
    }

    if (!hasCapture && (mergedLibLo | mergedLibHi) === 0) {
      return -1;
    }

    // 落子：更新棋盘、空点表与 Zobrist 哈希
    fb.board[idx] = color;
    const pos = fb.emptyPos[idx];
    const lastIdx = fb.emptyCount - 1;
    const lastEmpty = fb.emptyList[lastIdx];
    fb.emptyList[pos] = lastEmpty;
    fb.emptyPos[lastEmpty] = pos;
    fb.emptyPos[idx] = -1;
    fb.emptyCount = lastIdx;

    const zOff = color * geo.n + idx;
    fb.hashLo ^= geo.zobristLo[zOff];
    fb.hashHi ^= geo.zobristHi[zOff];

    fb.head[idx] = idx;
    fb.next[idx] = idx;
    fb.chainSize[idx] = 1;
    fb.libLo[idx] = ownLibLo;
    fb.libHi[idx] = ownLibHi;

    for (let i = 0; i < fCount; i += 1) {
      const h = _fHeads[i];
      fb.libLo[h] &= notBLo;
      fb.libHi[h] &= notBHi;
    }

    let capCount = 0;
    let lastCaptured = -1;
    const oppHashBase = opp * geo.n;

    for (let i = 0; i < eCount; i += 1) {
      const eh = _eHeads[i];
      fb.libLo[eh] &= notBLo;
      fb.libHi[eh] &= notBHi;
      if ((fb.libLo[eh] | fb.libHi[eh]) === 0) {
        let cur = eh;
        do {
          const nxt = fb.next[cur];
          fb.board[cur] = 0;
          fb.head[cur] = -1;
          fb.next[cur] = -1;

          fb.emptyPos[cur] = fb.emptyCount;
          fb.emptyList[fb.emptyCount] = cur;
          fb.emptyCount += 1;

          fb.hashLo ^= geo.zobristLo[oppHashBase + cur];
          fb.hashHi ^= geo.zobristHi[oppHashBase + cur];

          const sLo = geo.bitLo[cur];
          const sHi = geo.bitHi[cur];
          const sns = geo.neighbors[cur];
          for (let k = 0; k < sns.length; k += 1) {
            const sn = sns[k];
            if (fb.board[sn] === color) {
              const sh = fb.head[sn];
              fb.libLo[sh] |= sLo;
              fb.libHi[sh] |= sHi;
            }
          }

          capCount += 1;
          lastCaptured = cur;
          cur = nxt;
        } while (cur !== eh);

        fb.chainSize[eh] = 0;
        fb.libLo[eh] = 0;
        fb.libHi[eh] = 0;
      }
    }

    // 合并己方相邻棋块
    let myHead = idx;
    for (let i = 0; i < fCount; i += 1) {
      const fh = _fHeads[i];
      if (fh === myHead) continue;

      let big = myHead;
      let small = fh;
      if (fb.chainSize[small] > fb.chainSize[big]) {
        big = fh;
        small = myHead;
      }

      let cur = small;
      do {
        fb.head[cur] = big;
        cur = fb.next[cur];
      } while (cur !== small);

      const tmp = fb.next[big];
      fb.next[big] = fb.next[small];
      fb.next[small] = tmp;

      fb.chainSize[big] += fb.chainSize[small];
      fb.libLo[big] |= fb.libLo[small];
      fb.libHi[big] |= fb.libHi[small];
      fb.chainSize[small] = 0;
      fb.libLo[small] = 0;
      fb.libHi[small] = 0;
      myHead = big;
    }

    fb.ko = (capCount === 1 && fb.chainSize[myHead] === 1 && isSingleBitPair(fb.libLo[myHead], fb.libHi[myHead]))
      ? lastCaptured
      : -1;

    return capCount;
  }

  function matchesPattern3x3(fb, geo, idx, color) {
    const ring = geo.ring3x3[idx];
    const opp = color === 1 ? 2 : 1;
    let key = 0;
    for (let i = 0; i < 8; i += 1) {
      const nb = ring[i];
      let code;
      if (nb < 0) {
        code = 3;
      } else {
        const c = fb.board[nb];
        code = c === 0 ? 0 : (c === color ? 1 : 2);
      }
      key |= code << (i * 2);
    }
    return PATTERN_TABLE[key] === 1;
  }

  function fastAreaScore(fb, geo, ctx) {
    const n = geo.n;
    ctx.stampId += 1;
    if (ctx.stampId >= 2000000000) {
      ctx.visitStamp.fill(0);
      ctx.stampId = 1;
    }
    const stamp = ctx.stampId;
    const visitStamp = ctx.visitStamp;
    const bfsStack = ctx.bfsStack;
    const board = fb.board;

    let black = 0;
    let white = 0;

    for (let start = 0; start < n; start += 1) {
      const cell = board[start];
      if (cell === 1) {
        black += 1;
      } else if (cell === 2) {
        white += 1;
      } else if (visitStamp[start] !== stamp) {
        visitStamp[start] = stamp;
        bfsStack[0] = start;
        let sp = 1;
        let count = 0;
        let touchesBlack = false;
        let touchesWhite = false;

        while (sp > 0) {
          sp -= 1;
          const p = bfsStack[sp];
          count += 1;
          const ns = geo.neighbors[p];
          for (let i = 0; i < ns.length; i += 1) {
            const nb = ns[i];
            const nc = board[nb];
            if (nc === 1) {
              touchesBlack = true;
            } else if (nc === 2) {
              touchesWhite = true;
            } else if (visitStamp[nb] !== stamp) {
              visitStamp[nb] = stamp;
              bfsStack[sp] = nb;
              sp += 1;
            }
          }
        }

        if (touchesBlack && !touchesWhite) black += count;
        else if (touchesWhite && !touchesBlack) white += count;
      }
    }

    return black - white;
  }

  /* -----------------------------------------------------------------------
   * 效用函数与根节点 D4 对称归约
   * --------------------------------------------------------------------- */

  function computeUtility(scoreDiffBlack, n) {
    const winB = scoreDiffBlack > 0 ? 1 : (scoreDiffBlack < 0 ? 0 : 0.5);
    const bonus = Math.tanh(scoreDiffBlack / (n * 0.45));
    const utilB = 0.88 * winB + 0.12 * (0.5 + 0.5 * bonus);
    return { winB, utilB };
  }

  function computeRootSymmetry(board, geo, ko) {
    const n = geo.n;
    const validSyms = [0];
    for (let t = 1; t < 8; t += 1) {
      const sym = geo.symmetries[t];
      if (ko >= 0 && sym[ko] !== ko) continue;
      let match = true;
      for (let i = 0; i < n; i += 1) {
        if (board[sym[i]] !== board[i]) {
          match = false;
          break;
        }
      }
      if (match) validSyms.push(t);
    }

    const canonOf = new Int8Array(n);
    const equivalents = new Array(n);
    const seen = new Uint8Array(n);

    for (let idx = 0; idx < n; idx += 1) {
      if (seen[idx]) continue;
      const cls = [];
      let minIdx = idx;
      for (let s = 0; s < validSyms.length; s += 1) {
        const mapped = geo.symmetries[validSyms[s]][idx];
        if (!seen[mapped]) {
          seen[mapped] = 1;
          cls.push(mapped);
          if (mapped < minIdx) minIdx = mapped;
        }
      }
      cls.sort((a, b) => a - b);
      for (let k = 0; k < cls.length; k += 1) {
        canonOf[cls[k]] = minIdx;
      }
      equivalents[minIdx] = cls;
    }

    return {
      symCount: validSyms.length,
      canonOf,
      equivalents,
    };
  }

  /* -----------------------------------------------------------------------
   * MCTS 树节点、先验策略、PUCT + RAVE 与重推演
   * --------------------------------------------------------------------- */

  function createNode(move, prior, parent, color, depth, passes) {
    return {
      move,
      prior,
      parent,
      color,
      depth,
      passes,
      children: null,
      visits: 0,
      wins: 0,
      utilSum: 0,
      scoreSum: 0,
      amafVisits: 0,
      amafUtil: 0,
      terminal: false,
      terminalWin: 0,
      terminalUtil: 0,
      terminalScore: 0,
    };
  }

  function expandNode(node, fb, ctx, isRoot, sym) {
    if (node.terminal || node.children !== null) return;

    const geo = ctx.geo;
    const n = geo.n;
    const color = node.color;
    const opp = Go.opponent(color);
    const lastMove = isRoot ? ctx.rootLastMove : node.move;
    const stoneCount = n - fb.emptyCount;
    const candidates = [];
    let maxNonPassW = 0;
    let totalW = 0;

    for (let i = 0; i < fb.emptyCount; i += 1) {
      const idx = fb.emptyList[i];
      if (isRoot && sym && sym.canonOf[idx] !== idx) continue;
      if (isTrueEyeFast(fb, geo, idx, color)) continue;

      const info = inspectMove(fb, geo, idx, color, _inspectOut);
      if (!info.legal) continue;

      let w = geo.positional[idx];

      if (stoneCount < 8) {
        if (geo.size === 5 && idx === 12) w += 2.8;
        else if (geo.size === 6 && (idx === 14 || idx === 15 || idx === 20 || idx === 21)) w += 2.0;
      }

      const cap = info.capStones;
      const newLibs = info.newLibs;
      const newStones = info.newStones;
      const isBadSelfAtari = cap === 0 && newLibs === 1 && !info.putsEnemyInAtari;

      if (cap > 0) {
        w += 4.5 + cap * 3.5;
        if (cap === 1 && newLibs === 1) w *= 0.85;
      }

      if (info.savesAtariStones > 0) {
        if (newLibs >= 2) {
          w += 5.0 + info.savesAtariStones * 3.0 + (newLibs >= 3 ? 1.2 : 0);
        } else if (cap === 0 && !info.putsEnemyInAtari) {
          w = 0.06;
        }
      }

      if (info.putsEnemyInAtari) {
        if (newLibs >= 2) {
          w += 3.2 + info.atariEnemyStones * 1.4;
        } else if (cap === 0 && newStones === 1) {
          w = Math.max(w, 1.2);
        }
      }

      if (info.reducesEnemyTo2) w += 1.0;
      if (info.connectsFriendly) w += 1.8;
      if (info.cutsEnemy && newLibs >= 2) w += 1.6;
      if (info.enemyOrthCount === 0 && info.emptyOrthCount >= 2 && info.fCount > 0 && info.minFriendlyLibs <= 4) {
        w += 2.2;
      }
      if (matchesPattern3x3(fb, geo, idx, color)) {
        w += 1.3;
      }

      if (cap === 0 && newLibs === 1) {
        if (newStones >= 2 && !info.putsEnemyInAtari) {
          w = 0.03;
        } else if (newStones === 1 && !info.putsEnemyInAtari && info.enemyOrthCount < 3) {
          w = 0.05;
        } else if (newStones === 1 && info.enemyOrthCount >= 3) {
          w = Math.min(w, 0.85);
        }
      } else if (newLibs === 2 && cap === 0 && info.savesAtariStones === 0 && !info.putsEnemyInAtari) {
        w *= 0.82;
      }

      if (w > 0.1 && lastMove >= 0) {
        const dx = Math.abs(geo.xs[idx] - geo.xs[lastMove]);
        const dy = Math.abs(geo.ys[idx] - geo.ys[lastMove]);
        const dist = dx + dy;
        if (dist === 1) w += 1.2;
        else if (dx === 1 && dy === 1) w += 0.9;
        else if (dist === 2) w += 0.4;
      }

      if (w > maxNonPassW) maxNonPassW = w;
      totalW += w;
      candidates.push({ idx, w, isBadSelfAtari });
    }

    let passW;
    if (candidates.length === 0 || maxNonPassW < 0.12) {
      passW = 12.0;
    } else if (node.passes === 1) {
      passW = 2.0;
    } else if (stoneCount < 4) {
      passW = 0.02;
    } else {
      passW = 0.15;
    }

    totalW += passW;
    candidates.push({ idx: -1, w: passW, isBadSelfAtari: false });
    candidates.sort((a, b) => b.w - a.w);

    const children = new Array(candidates.length);
    for (let i = 0; i < candidates.length; i += 1) {
      const c = candidates[i];
      const childPasses = c.idx === -1 ? node.passes + 1 : 0;
      const child = createNode(c.idx, c.w / totalW, node, opp, node.depth + 1, childPasses);
      child.isBadSelfAtari = c.isBadSelfAtari;

      if (c.idx === -1 && childPasses >= 2) {
        child.terminal = true;
        const j = Go.judge(fb.board, geo, ctx.komi, true);
        const scoreDiffBlack = j.black - (j.white + ctx.komi);
        const { winB, utilB } = computeUtility(scoreDiffBlack, n);
        if (color === Go.BLACK) {
          child.terminalWin = winB;
          child.terminalUtil = utilB;
          child.terminalScore = scoreDiffBlack;
        } else {
          child.terminalWin = 1 - winB;
          child.terminalUtil = 1 - utilB;
          child.terminalScore = -scoreDiffBlack;
        }
      }

      children[i] = child;
    }

    node.children = children;
  }

  function selectChild(node) {
    const children = node.children;
    const len = children.length;
    if (len === 1) return children[0];

    const parentQ = node.visits > 0 ? (1 - node.utilSum / node.visits) : 0.5;
    const isRoot = node.parent === null;
    const fpu = isRoot ? Math.max(0.25, parentQ) : Math.max(0.05, parentQ - 0.18);
    const cPuct = isRoot ? 1.55 : 1.25;
    const sqrtParent = Math.sqrt(node.visits + 1);

    let best = null;
    let bestScore = -Infinity;

    for (let i = 0; i < len; i += 1) {
      const ch = children[i];
      let qBlend;
      if (ch.visits === 0) {
        if (ch.amafVisits > 0 && ch.move >= 0) {
          const beta0 = ch.amafVisits / (ch.amafVisits + 8);
          qBlend = (1 - beta0) * fpu + beta0 * (ch.amafUtil / ch.amafVisits);
        } else {
          qBlend = fpu;
        }
      } else {
        const q = ch.utilSum / ch.visits;
        if (ch.amafVisits > 0 && ch.move >= 0) {
          const beta = ch.amafVisits / (ch.visits + ch.amafVisits + 0.003 * ch.visits * ch.amafVisits);
          qBlend = (1 - beta) * q + beta * (ch.amafUtil / ch.amafVisits);
        } else {
          qBlend = q;
        }
      }

      const score = qBlend + cPuct * ch.prior * sqrtParent / (1 + ch.visits);
      if (score > bestScore) {
        bestScore = score;
        best = ch;
      }
    }

    return best;
  }

  function trySaveOrCaptureAround(fb, geo, color, lastMove) {
    const opp = color === 1 ? 2 : 1;

    // 1. 若上一手自己处于被打吃（仅 1 气），立即提吃
    if (fb.board[lastMove] === opp) {
      const eh = fb.head[lastMove];
      if (isSingleBitPair(fb.libLo[eh], fb.libHi[eh])) {
        const capIdx = singleBitIndex(fb.libLo[eh], fb.libHi[eh]);
        if (capIdx !== fb.ko && playFast(fb, geo, capIdx, color) >= 0) {
          return capIdx;
        }
      }
    }

    // 2. 若上一手使己方邻近棋块陷入打吃（仅 1 气），优先反提救子或长气逃出
    const ns = geo.neighbors[lastMove];
    for (let i = 0; i < ns.length; i += 1) {
      const nb = ns[i];
      if (fb.board[nb] !== color) continue;
      const fh = fb.head[nb];
      if (!isSingleBitPair(fb.libLo[fh], fb.libHi[fh])) continue;

      if (fb.chainSize[fh] <= 8) {
        let cur = fh;
        do {
          const sns = geo.neighbors[cur];
          for (let k = 0; k < sns.length; k += 1) {
            const sn = sns[k];
            if (fb.board[sn] === opp) {
              const eh = fb.head[sn];
              if (isSingleBitPair(fb.libLo[eh], fb.libHi[eh])) {
                const capIdx = singleBitIndex(fb.libLo[eh], fb.libHi[eh]);
                if (capIdx !== fb.ko && playFast(fb, geo, capIdx, color) >= 0) {
                  return capIdx;
                }
              }
            }
          }
          cur = fb.next[cur];
        } while (cur !== fh);
      }

      const escIdx = singleBitIndex(fb.libLo[fh], fb.libHi[fh]);
      if (escIdx !== fb.ko) {
        const info = inspectMove(fb, geo, escIdx, color, _inspectOut);
        if (info.legal && (info.newLibs >= 2 || info.capStones > 0 || info.putsEnemyInAtari)) {
          if (playFast(fb, geo, escIdx, color) >= 0) {
            return escIdx;
          }
        }
      }
    }

    return -1;
  }

  function simulateFast(fb, color, passes, lastMove, ctx) {
    const geo = ctx.geo;
    const maxPlies = Math.max(geo.n * 3, MIN_LOOKAHEAD_PLIES);
    const playoutMoves = ctx.playoutMoves;
    const playoutColors = ctx.playoutColors;
    const simHashStamp = ctx.simHashStamp;
    const simHashLo = ctx.simHashLo;
    const simHashHi = ctx.simHashHi;

    ctx.simId += 1;
    if (ctx.simId >= 2000000000) {
      simHashStamp.fill(0);
      ctx.simId = 1;
    }
    const simId = ctx.simId;

    let traceLen = 0;
    let ply = 0;
    let repeats = 0;

    while (passes < 2 && ply < maxPlies) {
      let played = -1;
      const opp = color === 1 ? 2 : 1;

      if (fb.emptyCount > 0) {
        // 1. 局部打吃救援 / 提吃
        if (lastMove >= 0 && nextRand(ctx) < 0.90) {
          played = trySaveOrCaptureAround(fb, geo, color, lastMove);
        }

        // 2. 上一手周边 MoGo 3×3 棋型
        if (played < 0 && lastMove >= 0 && nextRand(ctx) < 0.80) {
          const ring = geo.ring3x3[lastMove];
          const start = nextRandInt(ctx, 8);
          for (let k = 0; k < 8; k += 1) {
            const p = ring[(start + k) & 7];
            if (p < 0 || fb.board[p] !== 0 || p === fb.ko) continue;
            if (isTrueEyeFast(fb, geo, p, color)) continue;
            if (!matchesPattern3x3(fb, geo, p, color)) continue;

            const info = inspectMove(fb, geo, p, color, _inspectOut);
            if (!info.legal) continue;
            if (info.capStones === 0 && info.newLibs === 1 && !(info.newStones === 1 && info.putsEnemyInAtari)) {
              continue;
            }
            if (playFast(fb, geo, p, color) >= 0) {
              played = p;
              break;
            }
          }
        }

        // 3. 全局叫吃提子扫描
        if (played < 0 && nextRand(ctx) < 0.75) {
          const ec = fb.emptyCount;
          const start = nextRandInt(ctx, ec);
          for (let k = 0; k < ec; k += 1) {
            const pos = start + k < ec ? start + k : start + k - ec;
            const p = fb.emptyList[pos];
            if (p === fb.ko) continue;
            const ns = geo.neighbors[p];
            let captures = false;
            for (let j = 0; j < ns.length; j += 1) {
              const nb = ns[j];
              if (fb.board[nb] === opp) {
                const eh = fb.head[nb];
                if (isSingleBitPair(fb.libLo[eh], fb.libHi[eh])) {
                  captures = true;
                  break;
                }
              }
            }
            if (captures && playFast(fb, geo, p, color) >= 0) {
              played = p;
              break;
            }
          }
        }

        // 4. 无偏随机选点（拒绝真眼与无意义自叫吃）
        if (played < 0) {
          let rem = fb.emptyCount;
          while (rem > 0) {
            const r = nextRandInt(ctx, rem);
            const p = fb.emptyList[r];
            rem -= 1;
            if (r !== rem) {
              const tail = fb.emptyList[rem];
              fb.emptyList[r] = tail;
              fb.emptyList[rem] = p;
              fb.emptyPos[tail] = r;
              fb.emptyPos[p] = rem;
            }
            if (p === fb.ko || isTrueEyeFast(fb, geo, p, color)) continue;
            const info = inspectMove(fb, geo, p, color, _inspectOut);
            if (!info.legal) continue;
            if (info.capStones === 0 && info.newLibs === 1) {
              if (!(info.newStones === 1 && info.putsEnemyInAtari && nextRand(ctx) < 0.35)) {
                continue;
              }
            }
            if (playFast(fb, geo, p, color) >= 0) {
              played = p;
              break;
            }
          }
        }
      }

      if (traceLen < playoutMoves.length) {
        playoutMoves[traceLen] = played;
        playoutColors[traceLen] = color;
        traceLen += 1;
      }

      if (played >= 0) {
        passes = 0;
        lastMove = played;

        const slot = (fb.hashLo ^ fb.hashHi) & 255;
        if (simHashStamp[slot] === simId && simHashLo[slot] === fb.hashLo && simHashHi[slot] === fb.hashHi) {
          repeats += 1;
          if (repeats >= 2) break;
        } else {
          simHashStamp[slot] = simId;
          simHashLo[slot] = fb.hashLo;
          simHashHi[slot] = fb.hashHi;
        }
      } else {
        passes += 1;
        fb.ko = -1;
        lastMove = -1;
      }

      color = opp;
      ply += 1;
    }

    const areaDiff = fastAreaScore(fb, geo, ctx);
    return {
      scoreDiffBlack: areaDiff - ctx.komi,
      traceLen,
      plies: ply,
    };
  }

  function backpropagate(leaf, scoreDiffBlack, traceLen, ctx) {
    const geo = ctx.geo;
    const { winB, utilB } = computeUtility(scoreDiffBlack, geo.n);
    const firstColor = ctx.firstColor;
    const playoutMoves = ctx.playoutMoves;
    const playoutColors = ctx.playoutColors;

    firstColor.fill(0);
    for (let i = traceLen - 1; i >= 0; i -= 1) {
      const m = playoutMoves[i];
      if (m >= 0) firstColor[m] = playoutColors[i];
    }

    let cur = leaf;
    while (cur) {
      const moverColor = cur.parent ? cur.parent.color : Go.opponent(cur.color);
      const isBlackMover = moverColor === Go.BLACK;
      cur.visits += 1;
      cur.wins += isBlackMover ? winB : (1 - winB);
      cur.utilSum += isBlackMover ? utilB : (1 - utilB);
      cur.scoreSum += isBlackMover ? scoreDiffBlack : -scoreDiffBlack;

      if (cur.children !== null) {
        const childMover = cur.color;
        const amafU = childMover === Go.BLACK ? utilB : (1 - utilB);
        const children = cur.children;
        for (let i = 0; i < children.length; i += 1) {
          const ch = children[i];
          if (ch.move >= 0 && firstColor[ch.move] === childMover) {
            ch.amafVisits += 1;
            ch.amafUtil += amafU;
          }
        }
      }

      if (cur.parent && cur.move >= 0) {
        firstColor[cur.move] = cur.parent.color;
      }
      cur = cur.parent;
    }
  }

  function runIteration(rootNode, rootFb, ctx) {
    const fb = ctx.workBoard;
    copyFastBoard(fb, rootFb);

    const pathHashes = ctx.pathHashes;
    pathHashes[0] = fb.hashLo;
    pathHashes[1] = fb.hashHi;
    let pathLen = 1;

    let node = rootNode;
    let treePlies = 0;

    while (true) {
      if (node.terminal) break;

      if (node.children === null) {
        if (node === rootNode || node.visits >= EXPAND_THRESHOLD) {
          expandNode(node, fb, ctx, node === rootNode, node === rootNode ? ctx.sym : null);
        } else {
          break;
        }
      }

      const next = selectChild(node);
      if (!next) break;

      if (next.move >= 0) {
        const cap = playFast(fb, ctx.geo, next.move, node.color);
        if (cap < 0) {
          next.terminal = true;
          next.terminalWin = 0;
          next.terminalUtil = 0;
          next.terminalScore = -ctx.geo.n;
          node = next;
          break;
        }

        if (cap > 0) {
          let repeated = false;
          for (let i = 0; i < pathLen; i += 1) {
            if (pathHashes[i * 2] === fb.hashLo && pathHashes[i * 2 + 1] === fb.hashHi) {
              repeated = true;
              break;
            }
          }
          if (repeated) {
            next.terminal = true;
            next.terminalWin = 0.5;
            next.terminalUtil = 0.5;
            next.terminalScore = 0;
            node = next;
            break;
          }
        }
      }

      if (pathLen * 2 < pathHashes.length) {
        pathHashes[pathLen * 2] = fb.hashLo;
        pathHashes[pathLen * 2 + 1] = fb.hashHi;
        pathLen += 1;
      }

      node = next;
      treePlies += 1;
      if (node.visits === 0) break;
    }

    let scoreDiffBlack;
    let traceLen = 0;
    let simPlies = 0;

    if (node.terminal) {
      const mover = node.parent ? node.parent.color : Go.opponent(node.color);
      scoreDiffBlack = mover === Go.BLACK ? node.terminalScore : -node.terminalScore;
    } else {
      const lastMove = node === rootNode ? ctx.rootLastMove : node.move;
      const sim = simulateFast(fb, node.color, node.passes, lastMove, ctx);
      scoreDiffBlack = sim.scoreDiffBlack;
      traceLen = sim.traceLen;
      simPlies = sim.plies;
    }

    backpropagate(node, scoreDiffBlack, traceLen, ctx);

    return {
      treeDepth: node.depth,
      readDepth: treePlies + simPlies,
    };
  }

  function createSearchContext(geo, komi, rootLastMove, seed, sym) {
    const n = geo.n;
    return {
      geo,
      komi,
      rootLastMove,
      sym: sym || null,
      rng: (seed | 0) || 0x12345679,
      workBoard: createFastBoard(n),
      visitStamp: new Int32Array(n),
      stampId: 0,
      bfsStack: new Uint8Array(n),
      playoutMoves: new Int8Array(128),
      playoutColors: new Uint8Array(128),
      firstColor: new Uint8Array(n),
      pathHashes: new Int32Array(256),
      simHashStamp: new Int32Array(256),
      simHashLo: new Int32Array(256),
      simHashHi: new Int32Array(256),
      simId: 0,
    };
  }

  function focusedEvaluateMove(rootFb, geo, komi, toMove, passes, rootLastMove, move, iterations, seed) {
    const subFb = createFastBoard(geo.n);
    copyFastBoard(subFb, rootFb);

    if (move >= 0) {
      if (playFast(subFb, geo, move, toMove) < 0) return null;
    }

    const subPasses = move === -1 ? passes + 1 : 0;
    if (subPasses >= 2) {
      const j = Go.judge(subFb.board, geo, komi, true);
      const scoreDiffBlack = j.black - (j.white + komi);
      const { winB, utilB } = computeUtility(scoreDiffBlack, geo.n);
      const isBlack = toMove === Go.BLACK;
      return {
        winRate: isBlack ? winB : (1 - winB),
        util: isBlack ? utilB : (1 - utilB),
        score: isBlack ? scoreDiffBlack : -scoreDiffBlack,
        visits: 1,
      };
    }

    const opp = Go.opponent(toMove);
    const subCtx = createSearchContext(geo, komi, move, seed, null);
    const subRoot = createNode(move, 1, null, opp, 0, subPasses);

    for (let i = 0; i < iterations; i += 1) {
      runIteration(subRoot, subFb, subCtx);
    }

    const v = Math.max(1, subRoot.visits);
    return {
      winRate: subRoot.wins / v,
      util: subRoot.utilSum / v,
      score: subRoot.scoreSum / v,
      visits: v,
    };
  }

  /* -----------------------------------------------------------------------
   * 对局选点（chooseMove）与复盘逐手分析（analyzePosition）
   * --------------------------------------------------------------------- */

  function lcbScore(ch, cLcb) {
    if (ch.terminal) return ch.terminalUtil;
    if (ch.visits === 0) return -Infinity;
    return (ch.utilSum / ch.visits) - cLcb / Math.sqrt(ch.visits + 1);
  }

  function resolveSymmetricMove(move, sym, level) {
    if (move < 0 || !sym) return move;
    const eq = sym.equivalents[move];
    if (!eq || eq.length <= 1) return move;
    if (level === 'hard') return eq[0];
    return eq[Math.floor(Math.random() * eq.length)];
  }

  function chooseRootChild(rootNode, rootFb, ctx, level) {
    const children = rootNode.children;
    if (!children || children.length === 0) return null;

    let bestVisits = 0;
    for (let i = 0; i < children.length; i += 1) {
      if (children[i].visits > bestVisits) bestVisits = children[i].visits;
    }

    const directPass = children.find((ch) => ch.move === -1) || null;
    if (directPass && ctx.opponentPassed) {
      const judge = Go.judge(rootFb.board, ctx.geo, ctx.komi, true);
      if (judge.winner === ctx.aiColor) return directPass;
    }

    const visited = children.filter((ch) => ch.visits > 0 || ch.terminal);
    if (visited.length === 0) return children[0];

    if (level === 'easy') {
      const candidates = visited.filter((ch) => !ch.isBadSelfAtari && ch.move !== -1);
      const pool = candidates.length > 0 ? candidates : visited;
      pool.sort((a, b) => (b.utilSum / Math.max(1, b.visits)) - (a.utilSum / Math.max(1, a.visits)));
      const topRate = pool[0].visits > 0 ? pool[0].wins / pool[0].visits : 0;
      const near = pool.filter((ch) => (ch.visits > 0 ? ch.wins / ch.visits : 0) >= topRate - 0.07);
      const weights = near.map((ch) => Math.exp(((ch.utilSum / Math.max(1, ch.visits)) - topRate) * 14));
      let sum = 0;
      for (let i = 0; i < weights.length; i += 1) sum += weights[i];
      let r = Math.random() * sum;
      for (let i = 0; i < near.length; i += 1) {
        r -= weights[i];
        if (r <= 0) return near[i];
      }
      return near[0];
    }

    const minVisits = Math.max(10, Math.floor(bestVisits * 0.25));
    const eligible = visited.filter((ch) => ch.terminal || ch.visits >= minVisits);
    const pool = eligible.length > 0 ? eligible : visited;
    const cLcb = level === 'hard' ? 1.35 : 1.2;

    pool.sort((a, b) => {
      const diff = lcbScore(b, cLcb) - lcbScore(a, cLcb);
      if (Math.abs(diff) > 1e-6) return diff;
      return b.visits - a.visits;
    });

    return pool[0];
  }

  function analyzePosition(options) {
    const startedAt = now();
    const size = options.size === 6 ? 6 : 5;
    const geo = Go.makeGeometry(size);
    const board = Uint8Array.from(options.board || []);
    if (board.length !== geo.n) throw new Error('棋盘尺寸与棋盘数据不匹配');

    const toMove = options.toMove === Go.WHITE ? Go.WHITE : Go.BLACK;
    const komi = Number.isFinite(options.komi) ? options.komi : 3.5;
    const ko = Number.isInteger(options.ko) ? options.ko : -1;
    const passes = Number.isInteger(options.passes) ? options.passes : 0;
    const lastMove = Number.isInteger(options.lastMove) ? options.lastMove : -1;
    const playedMove = Number.isInteger(options.playedMove) ? options.playedMove : null;
    const topN = Math.max(1, Math.min(12, Math.round(Number(options.topN) || 3)));

    if (passes >= 2) {
      const judge = Go.judge(board, geo, komi, true);
      const rate = judge.winner === Go.EMPTY ? 0.5 : (judge.winner === toMove ? 1 : 0);
      return {
        toMove,
        terminal: true,
        bestRate: rate,
        passRate: rate,
        playedRate: null,
        playedRank: null,
        evaluated: 0,
        playouts: 0,
        elapsedMs: Math.round(now() - startedAt),
        candidates: [],
      };
    }

    const requestedIterations = Number(options.iterations);
    const legacyIterations = Number.isFinite(Number(options.playoutsPerMove))
      ? Number(options.playoutsPerMove) * 16
      : 2400;
    const iterations = Math.max(
      100,
      Math.min(20000, Math.round(
        Number.isFinite(requestedIterations) && requestedIterations > 0
          ? requestedIterations
          : legacyIterations,
      )),
    );

    const rootFb = createFastBoard(geo.n);
    initFastBoard(rootFb, board, geo, ko);
    const sym = computeRootSymmetry(board, geo, ko);

    let seed = (rootFb.hashLo ^ rootFb.hashHi ^ (toMove * 0x9e3779b9) ^ (passes * 0x85ebca6b)) | 0;
    if (seed === 0) seed = 0x243f6a88;

    const ctx = createSearchContext(geo, komi, lastMove, seed, sym);
    const rootNode = createNode(null, 1, null, toMove, 0, passes);

    for (let i = 0; i < iterations; i += 1) {
      runIteration(rootNode, rootFb, ctx);
    }

    const children = rootNode.children || [];
    const visitedChildren = children.filter((ch) => ch.visits > 0 || ch.terminal);

    // 确保 PASS 的胜率与目数有足够样本，避免极低先验导致评估失真
    const passChild = children.find((ch) => ch.move === -1) || null;
    let passWinRate = 0.5;
    let passUtil = 0.5;
    let passScore = 0;
    if (passChild) {
      if (passChild.terminal) {
        passWinRate = passChild.terminalWin;
        passUtil = passChild.terminalUtil;
        passScore = passChild.terminalScore;
      } else if (passChild.visits >= 80) {
        passWinRate = passChild.wins / passChild.visits;
        passUtil = passChild.utilSum / passChild.visits;
        passScore = passChild.scoreSum / passChild.visits;
      } else {
        const verifiedPass = focusedEvaluateMove(
          rootFb,
          geo,
          komi,
          toMove,
          passes,
          lastMove,
          -1,
          100,
          (seed ^ 0x517cc1b7) | 0,
        );
        if (verifiedPass) {
          passWinRate = verifiedPass.winRate;
          passUtil = verifiedPass.util;
          passScore = verifiedPass.score;
        }
      }
    }

    const ranked = visitedChildren.map((ch) => {
      const isPass = ch.move === -1;
      const winRate = isPass ? passWinRate : (ch.wins / ch.visits);
      const util = isPass ? passUtil : (ch.utilSum / ch.visits);
      const score = isPass ? passScore : (ch.scoreSum / ch.visits);
      const rankScore = ch.terminal
        ? ch.terminalUtil
        : (util - 0.95 / Math.sqrt(Math.max(1, ch.visits) + 1));
      return {
        ch,
        idx: ch.move,
        pass: isPass,
        winRate,
        util,
        score,
        visits: ch.visits,
        isBadSelfAtari: Boolean(ch.isBadSelfAtari),
        rankScore,
      };
    });

    ranked.sort((a, b) => {
      const diff = b.rankScore - a.rankScore;
      if (Math.abs(diff) > 1e-6) return diff;
      return b.visits - a.visits;
    });

    // 若已进入双方收官完毕状态（存在 PASS 且最佳棋盘着法无法带来任何胜率或目数增益），让 PASS 领衔
    const bestBoardEntry = ranked.find((r) => !r.pass);
    const passEntry = ranked.find((r) => r.pass);
    if (
      passEntry
      && bestBoardEntry
      && passEntry.winRate >= bestBoardEntry.winRate - 0.01
      && passEntry.score >= bestBoardEntry.score - 0.2
      && (bestBoardEntry.winRate >= 0.985 || bestBoardEntry.winRate <= 0.015 || bestBoardEntry.score <= passEntry.score + 0.1)
    ) {
      ranked.sort((a, b) => {
        if (a.pass && !b.pass && b.score <= passEntry.score + 0.25 && b.winRate <= passEntry.winRate + 0.01) return -1;
        if (b.pass && !a.pass && a.score <= passEntry.score + 0.25 && a.winRate <= passEntry.winRate + 0.01) return 1;
        const diff = b.rankScore - a.rankScore;
        if (Math.abs(diff) > 1e-6) return diff;
        return b.visits - a.visits;
      });
    }

    const bestEntry = ranked[0] || null;
    const passIsTop = Boolean(bestEntry && bestEntry.pass);
    const bestNonPassRate = bestBoardEntry ? bestBoardEntry.winRate : 0;

    const recommended = ranked.filter((item) => {
      if (item.pass) {
        return passIsTop || item.winRate >= bestNonPassRate - 0.05 || item.winRate >= 0.5;
      }
      if (item.isBadSelfAtari && item.util <= passUtil + 0.01) return false;
      if (passIsTop && item.score <= passScore + 0.25 && item.winRate <= passWinRate + 0.01) return false;
      if (iterations >= 400 && item.visits < 5) return false;
      return true;
    });

    const finalPool = recommended.length > 0 ? recommended : ranked;

    // 精确评估实战着法（含低访问着法与己方真眼自填）
    let playedRate = null;
    let playedUtil = null;
    let playedRank = null;
    let evaluated = ranked.length;

    if (playedMove !== null) {
      const canonPlayed = playedMove >= 0 ? sym.canonOf[playedMove] : -1;
      const rankedIndex = ranked.findIndex((r) => r.idx === canonPlayed);
      const childMatch = children.find((ch) => ch.move === canonPlayed) || null;

      if (canonPlayed === -1 && passEntry) {
        playedRate = passWinRate;
        playedUtil = passUtil;
        playedRank = rankedIndex + 1;
      } else if (childMatch && !childMatch.terminal && childMatch.visits >= 120) {
        playedRate = ranked[rankedIndex].winRate;
        playedUtil = ranked[rankedIndex].util;
        playedRank = rankedIndex + 1;
      } else {
        const verified = focusedEvaluateMove(
          rootFb,
          geo,
          komi,
          toMove,
          passes,
          lastMove,
          canonPlayed,
          160,
          (seed ^ ((canonPlayed + 17) * 0x27d4eb2d)) | 0,
        );
        if (verified) {
          playedRate = verified.winRate;
          playedUtil = verified.util;
          if (rankedIndex >= 0) {
            ranked[rankedIndex].winRate = verified.winRate;
            ranked[rankedIndex].util = verified.util;
            ranked[rankedIndex].score = verified.score;
            playedRank = rankedIndex + 1;
          } else {
            let better = 0;
            for (let i = 0; i < ranked.length; i += 1) {
              if (ranked[i].util > playedUtil) better += 1;
            }
            playedRank = better + 1;
            evaluated += 1;
          }
        }
      }
    }

    const bestRate = bestEntry ? bestEntry.winRate : 0.5;
    const outputCandidates = finalPool.slice(0, topN).map((item) => {
      let outIdx = item.idx;
      if (!item.pass && playedMove !== null && playedMove >= 0 && sym.canonOf[playedMove] === item.idx) {
        outIdx = playedMove;
      }
      return {
        idx: outIdx,
        winRate: item.winRate,
        pass: item.pass,
        score: item.score,
      };
    });

    return {
      toMove,
      terminal: false,
      bestRate,
      passRate: passWinRate,
      playedRate,
      playedRank,
      evaluated,
      playouts: iterations,
      elapsedMs: Math.round(now() - startedAt),
      candidates: outputCandidates,
    };
  }

  function chooseMove(options) {
    const startedAt = now();
    const size = options.size === 6 ? 6 : 5;
    const geo = Go.makeGeometry(size);
    const board = Uint8Array.from(options.board);
    const aiColor = options.aiColor === Go.WHITE ? Go.WHITE : Go.BLACK;
    const toMove = options.toMove === Go.WHITE ? Go.WHITE : Go.BLACK;
    const komi = Number.isFinite(options.komi) ? options.komi : 3.5;
    const ko = Number.isInteger(options.ko) ? options.ko : -1;
    const opponentPassed = Boolean(options.opponentPassed);
    const lastMove = Number.isInteger(options.lastMove) ? options.lastMove : -1;
    const level = options.level || 'normal';
    const timeLimit = Math.max(
      150,
      Math.min(MAX_TIME_LIMIT, Number(options.timeLimit) || DEFAULT_TIME_LIMIT),
    );

    if (toMove !== aiColor) {
      throw new Error('AI 未轮到落子');
    }

    const rootFb = createFastBoard(geo.n);
    initFastBoard(rootFb, board, geo, ko);
    const sym = computeRootSymmetry(board, geo, ko);

    let seed = (rootFb.hashLo ^ rootFb.hashHi ^ Math.floor(Math.random() * 0x7fffffff)) | 0;
    if (level === 'hard') {
      seed = (rootFb.hashLo ^ rootFb.hashHi ^ (toMove * 0x9e3779b9)) | 0;
    }
    if (seed === 0) seed = 0x243f6a88;

    const ctx = createSearchContext(geo, komi, lastMove, seed, sym);
    ctx.aiColor = aiColor;
    ctx.opponentPassed = opponentPassed;

    const rootNode = createNode(null, 1, null, toMove, 0, opponentPassed ? 1 : 0);

    // 若对手刚停一手且此时数子必胜，直接停一手锁定胜局
    if (opponentPassed) {
      const quickJudge = Go.judge(board, geo, komi, true);
      if (quickJudge.winner === aiColor) {
        return {
          move: -1,
          pass: true,
          stats: {
            simulations: 1,
            elapsedMs: Math.round(now() - startedAt),
            treeDepth: 1,
            readDepth: 1,
            chosenVisits: 1,
            chosenWinRate: 1,
            rootVisits: 1,
            currentScore: quickJudge,
            lookaheadPlies: MIN_LOOKAHEAD_PLIES,
          },
        };
      }
    }

    const maxSims = level === 'easy' ? 300 : level === 'normal' ? 12000 : 200000;
    const deadline = startedAt + timeLimit;
    let simulations = 0;
    let maxReadDepth = 0;
    let maxTreeDepth = 0;

    while (simulations < maxSims && now() < deadline) {
      const res = runIteration(rootNode, rootFb, ctx);
      simulations += 1;
      if (res.readDepth > maxReadDepth) maxReadDepth = res.readDepth;
      if (res.treeDepth > maxTreeDepth) maxTreeDepth = res.treeDepth;
    }

    while ((!rootNode.children || rootNode.children.length === 0) && simulations < 32) {
      const res = runIteration(rootNode, rootFb, ctx);
      simulations += 1;
      maxReadDepth = Math.max(maxReadDepth, res.readDepth);
      maxTreeDepth = Math.max(maxTreeDepth, res.treeDepth);
    }

    const chosen = chooseRootChild(rootNode, rootFb, ctx, level);
    const rawMove = chosen ? chosen.move : -1;
    const move = resolveSymmetricMove(rawMove, sym, level);
    const elapsed = now() - startedAt;

    return {
      move,
      pass: move === -1,
      stats: {
        simulations,
        elapsedMs: Math.round(elapsed),
        treeDepth: maxTreeDepth,
        readDepth: maxReadDepth,
        chosenVisits: chosen ? chosen.visits : 0,
        chosenWinRate: chosen
          ? (chosen.terminal ? chosen.terminalWin : (chosen.visits > 0 ? chosen.wins / chosen.visits : 0))
          : 0,
        rootVisits: rootNode.visits,
        currentScore: Go.judge(board, geo, komi, true),
        lookaheadPlies: MIN_LOOKAHEAD_PLIES,
      },
    };
  }

  root.GoAI = {
    chooseMove,
    analyzePosition,
    MIN_LOOKAHEAD_PLIES,
    // 仅供测试与验证的 FastBoard 原语
    _internal: {
      createFastBoard,
      initFastBoard,
      copyFastBoard,
      playFast,
      fastAreaScore,
      isTrueEyeFast,
      matchesPattern3x3,
    },
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.GoAI;
  }
})(typeof self !== 'undefined' ? self : globalThis);
