/*
 * 小棋盘围棋规则引擎
 * 5×5 / 6×6，无禁着点之外的复杂规则：
 * - 禁止自杀
 * - 简单劫争
 * - 连续两次停一手终局
 * - 中国规则数子法（白棋贴子由界面传入）
 */
(function (root) {
  'use strict';

  const EMPTY = 0;
  const BLACK = 1;
  const WHITE = 2;
  const LETTERS = 'ABCDEFGHJKLMNOPQRST';

  const geometryCache = Object.create(null);

  const RING_DX = [0, 1, 1, 1, 0, -1, -1, -1];
  const RING_DY = [-1, -1, 0, 1, 1, 1, 0, -1];

  function makeGeometry(size) {
    if (geometryCache[size]) return geometryCache[size];

    const n = size * size;
    const neighbors = new Array(n);
    const diagonals = new Array(n);
    const xs = new Uint8Array(n);
    const ys = new Uint8Array(n);
    const edgeDistance = new Uint8Array(n);
    const positional = new Float32Array(n);
    const bitLo = new Int32Array(n);
    const bitHi = new Int32Array(n);
    const ring3x3 = new Array(n);
    const center = (size - 1) / 2;
    const maxCenterDistance = Math.max(1, Math.hypot(center, center));

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const idx = y * size + x;
        xs[idx] = x;
        ys[idx] = y;

        if (idx < 32) {
          bitLo[idx] = 1 << idx;
        } else {
          bitHi[idx] = 1 << (idx - 32);
        }

        const nList = [];
        if (x > 0) nList.push(idx - 1);
        if (x < size - 1) nList.push(idx + 1);
        if (y > 0) nList.push(idx - size);
        if (y < size - 1) nList.push(idx + size);
        neighbors[idx] = Uint8Array.from(nList);

        const dList = [];
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx !== 0 && dy !== 0) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
                dList.push(ny * size + nx);
              }
            }
          }
        }
        diagonals[idx] = Uint8Array.from(dList);

        const ring = new Int8Array(8);
        for (let d = 0; d < 8; d += 1) {
          const nx = x + RING_DX[d];
          const ny = y + RING_DY[d];
          ring[d] = (nx >= 0 && nx < size && ny >= 0 && ny < size) ? (ny * size + nx) : -1;
        }
        ring3x3[idx] = ring;

        const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
        edgeDistance[idx] = edge;
        let value = edge === 0 ? 0.32 : edge === 1 ? 1.02 : 1.5;
        const centerDistance = Math.hypot(x - center, y - center) / maxCenterDistance;
        value += (1 - centerDistance) * 0.4;
        positional[idx] = value;
      }
    }

    const symmetries = Array.from({ length: 8 }, () => new Uint8Array(n));
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const idx = y * size + x;
        const rx = size - 1 - x;
        const ry = size - 1 - y;
        symmetries[0][idx] = y * size + x;
        symmetries[1][idx] = x * size + ry;
        symmetries[2][idx] = ry * size + rx;
        symmetries[3][idx] = rx * size + y;
        symmetries[4][idx] = y * size + rx;
        symmetries[5][idx] = ry * size + x;
        symmetries[6][idx] = x * size + y;
        symmetries[7][idx] = rx * size + ry;
      }
    }

    const zobristLo = new Int32Array(3 * n);
    const zobristHi = new Int32Array(3 * n);
    let zSeed = (0x9e3779b9 ^ Math.imul(size, 0x85ebca6b)) | 0;
    const nextZobrist32 = () => {
      zSeed = (zSeed + 0x9e3779b9) | 0;
      let z = zSeed;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
      return (z ^ (z >>> 16)) | 0;
    };
    for (let color = 1; color <= 2; color += 1) {
      for (let idx = 0; idx < n; idx += 1) {
        const offset = color * n + idx;
        let lo = nextZobrist32();
        let hi = nextZobrist32();
        if ((lo | hi) === 0) lo = 1;
        zobristLo[offset] = lo;
        zobristHi[offset] = hi;
      }
    }

    const geo = {
      size,
      n,
      neighbors,
      diagonals,
      xs,
      ys,
      edgeDistance,
      positional,
      bitLo,
      bitHi,
      ring3x3,
      symmetries,
      zobristLo,
      zobristHi,
    };
    geometryCache[size] = geo;
    return geo;
  }

  function newBoard(size) {
    if (!geometryCache[size]) makeGeometry(size);
    return new Uint8Array(size * size);
  }

  function opponent(color) {
    return color === BLACK ? WHITE : BLACK;
  }

  /**
   * 返回棋块的所有棋子与所有气。
   */
  function groupAt(board, geo, start) {
    const color = board[start];
    if (color === EMPTY) return { stones: [], liberties: [] };

    const seen = new Uint8Array(geo.n);
    const seenLiberty = new Uint8Array(geo.n);
    const stones = [];
    const liberties = [];
    const stack = [start];
    seen[start] = 1;

    while (stack.length) {
      const point = stack.pop();
      stones.push(point);
      const ns = geo.neighbors[point];
      for (let i = 0; i < ns.length; i += 1) {
        const next = ns[i];
        if (board[next] === EMPTY) {
          if (!seenLiberty[next]) {
            seenLiberty[next] = 1;
            liberties.push(next);
          }
        } else if (board[next] === color && !seen[next]) {
          seen[next] = 1;
          stack.push(next);
        }
      }
    }

    return { stones, liberties };
  }

  /**
   * 在棋盘上落子。成功时直接修改 board；失败时恢复原状并返回 null。
   */
  function play(board, geo, idx, color, koPoint) {
    if (idx < 0 || idx >= geo.n) return null;
    if (board[idx] !== EMPTY || idx === koPoint) return null;

    const opp = opponent(color);
    board[idx] = color;
    const captured = [];
    const ns = geo.neighbors[idx];

    for (let i = 0; i < ns.length; i += 1) {
      const point = ns[i];
      if (board[point] !== opp) continue;
      const group = groupAt(board, geo, point);
      if (group.liberties.length === 0) {
        for (let j = 0; j < group.stones.length; j += 1) {
          const stone = group.stones[j];
          board[stone] = EMPTY;
          captured.push(stone);
        }
      }
    }

    const own = groupAt(board, geo, idx);
    if (own.liberties.length === 0) {
      board[idx] = EMPTY;
      for (let i = 0; i < captured.length; i += 1) {
        board[captured[i]] = opp;
      }
      return null;
    }

    let nextKo = -1;
    if (captured.length === 1 && own.liberties.length === 1 && own.stones.length === 1) {
      nextKo = captured[0];
    }

    return {
      captured,
      ko: nextKo,
      liberties: own.liberties.length,
    };
  }

  /**
   * 撤销由 play 落下的棋子。仅用于搜索中的试走。
   */
  function unplay(board, idx, color, captured) {
    board[idx] = EMPTY;
    const opp = opponent(color);
    for (let i = 0; i < captured.length; i += 1) {
      board[captured[i]] = opp;
    }
  }

  /**
   * 严格且标准地判断一个空点是否为“自己的真眼”。
   * 规则：
   * 1. 邻居点必须全为己方棋子；
   * 2. 角部（2邻居）对角线不能有敌方棋子；
   * 3. 边上（3邻居）对角线不能有敌方棋子；
   * 4. 中央（4邻居）对角线最多允许 1 个敌方棋子。
   * 空白对角点是允许的，不会误判为非眼。
   */
  function isSimpleEye(board, geo, idx, color) {
    if (board[idx] !== EMPTY) return false;

    const ns = geo.neighbors[idx];
    for (let i = 0; i < ns.length; i += 1) {
      if (board[ns[i]] !== color) return false;
    }

    const ds = geo.diagonals[idx];
    if (ds.length === 0) return true;

    const opp = opponent(color);
    let enemyDiagonals = 0;
    for (let i = 0; i < ds.length; i += 1) {
      if (board[ds[i]] === opp) enemyDiagonals += 1;
    }

    const maxEnemyAllowed = ns.length === 4 ? 1 : 0;
    return enemyDiagonals <= maxEnemyAllowed;
  }

  /**
   * 中国规则数子：棋子 + 单方围住的空点。
   * 同时接触黑白双方的空区视为单官，不计入任何一方。
   */
  function areaScore(board, geo) {
    let black = 0;
    let white = 0;
    let neutral = 0;

    for (let i = 0; i < geo.n; i += 1) {
      if (board[i] === BLACK) black += 1;
      else if (board[i] === WHITE) white += 1;
    }

    const visited = new Uint8Array(geo.n);
    for (let start = 0; start < geo.n; start += 1) {
      if (board[start] !== EMPTY || visited[start]) continue;

      const stack = [start];
      visited[start] = 1;
      let count = 0;
      let touchesBlack = false;
      let touchesWhite = false;

      while (stack.length) {
        const point = stack.pop();
        count += 1;
        const ns = geo.neighbors[point];
        for (let i = 0; i < ns.length; i += 1) {
          const next = ns[i];
          if (board[next] === BLACK) touchesBlack = true;
          else if (board[next] === WHITE) touchesWhite = true;
          else if (!visited[next]) {
            visited[next] = 1;
            stack.push(next);
          }
        }
      }

      if (touchesBlack && !touchesWhite) black += count;
      else if (touchesWhite && !touchesBlack) white += count;
      else neutral += count;
    }

    return { black, white, neutral };
  }

  /**
   * 判断空点是否处于己方封闭的纯眼域/实地中（<=4 目且无任何敌方棋子接触）。
   * 走在其中纯属自填眼/自填目，毫无防御或攻击意义。
   */
  function isSafeTerritory(board, geo, idx, color) {
    if (board[idx] !== EMPTY) return false;
    const opp = opponent(color);
    const visited = new Uint8Array(geo.n);
    const stack = [idx];
    visited[idx] = 1;
    let count = 0;

    while (stack.length > 0) {
      const p = stack.pop();
      count += 1;
      const ns = geo.neighbors[p];
      for (let i = 0; i < ns.length; i += 1) {
        const next = ns[i];
        if (board[next] === opp) {
          return false;
        } else if (board[next] === EMPTY && !visited[next]) {
          visited[next] = 1;
          stack.push(next);
        }
      }
    }

    return count <= 4;
  }

  /**
   * 检测棋盘上的无条件死子（孤子或被困在健康敌棋领地内、无法做活且不构成双活的死棋）。
   */
  function findDeadGroups(board, geo) {
    const n = geo.n;
    const visited = new Uint8Array(n);
    const groupIdOf = new Int16Array(n);
    groupIdOf.fill(-1);
    const groups = [];

    for (let i = 0; i < n; i += 1) {
      if (board[i] === EMPTY || visited[i]) continue;
      const group = groupAt(board, geo, i);
      const id = groups.length;
      for (let j = 0; j < group.stones.length; j += 1) {
        const stone = group.stones[j];
        visited[stone] = 1;
        groupIdOf[stone] = id;
      }
      group.color = board[i];
      let hasTrueEye = false;
      for (let j = 0; j < group.liberties.length; j += 1) {
        if (isSimpleEye(board, geo, group.liberties[j], group.color)) {
          hasTrueEye = true;
          break;
        }
      }
      group.hasTrueEye = hasTrueEye;
      groups.push(group);
    }

    const dead = [];
    const maxDeadStones = Math.ceil(n / 2);
    const emptyMark = new Uint8Array(n);
    const oppSeen = new Uint8Array(groups.length);

    for (let gId = 0; gId < groups.length; gId += 1) {
      const g = groups[gId];
      if (g.stones.length >= maxDeadStones) continue;
      if (g.liberties.length > 2 || g.hasTrueEye) continue;

      const ownColor = g.color;
      const oppColor = opponent(ownColor);
      emptyMark.fill(0);
      oppSeen.fill(0);

      const queue = [];
      for (let j = 0; j < g.liberties.length; j += 1) {
        const lib = g.liberties[j];
        if (!emptyMark[lib]) {
          emptyMark[lib] = 1;
          queue.push(lib);
        }
      }

      let touchesOtherFriendly = false;
      const adjOppIds = [];

      let headIdx = 0;
      while (headIdx < queue.length) {
        const p = queue[headIdx];
        headIdx += 1;
        if (queue.length > 2) break;

        const ns = geo.neighbors[p];
        for (let k = 0; k < ns.length; k += 1) {
          const nb = ns[k];
          const c = board[nb];
          if (c === EMPTY) {
            if (!emptyMark[nb]) {
              emptyMark[nb] = 1;
              queue.push(nb);
              if (queue.length > 2) break;
            }
          } else if (c === ownColor) {
            if (groupIdOf[nb] !== gId) {
              touchesOtherFriendly = true;
              break;
            }
          } else {
            const ogId = groupIdOf[nb];
            if (!oppSeen[ogId]) {
              oppSeen[ogId] = 1;
              adjOppIds.push(ogId);
            }
          }
        }
        if (touchesOtherFriendly || queue.length > 2) break;
      }

      if (touchesOtherFriendly || queue.length > 2) continue;

      for (let j = 0; j < g.stones.length; j += 1) {
        const ns = geo.neighbors[g.stones[j]];
        for (let k = 0; k < ns.length; k += 1) {
          const nb = ns[k];
          if (board[nb] === oppColor) {
            const ogId = groupIdOf[nb];
            if (!oppSeen[ogId]) {
              oppSeen[ogId] = 1;
              adjOppIds.push(ogId);
            }
          }
        }
      }

      if (adjOppIds.length === 0) continue;

      let allHealthy = true;
      for (let j = 0; j < adjOppIds.length; j += 1) {
        const og = groups[adjOppIds[j]];
        if (og.liberties.length < 2) {
          allHealthy = false;
          break;
        }
        if (og.hasTrueEye || og.liberties.length >= 3) continue;

        if (og.liberties.length > g.liberties.length) {
          let hasOutsideLib = false;
          for (let l = 0; l < og.liberties.length; l += 1) {
            if (!emptyMark[og.liberties[l]]) {
              hasOutsideLib = true;
              break;
            }
          }
          if (hasOutsideLib) continue;
        }

        allHealthy = false;
        break;
      }

      if (allHealthy) {
        for (let j = 0; j < g.stones.length; j += 1) {
          dead.push(g.stones[j]);
        }
      }
    }
    return dead;
  }

  function resolveBoard(board, geo) {
    const dead = findDeadGroups(board, geo);
    if (dead.length === 0) return { board, dead };
    const clean = board.slice();
    for (let i = 0; i < dead.length; i += 1) {
      clean[dead[i]] = EMPTY;
    }
    return { board: clean, dead };
  }

  function judge(board, geo, komi, resolveDead = true) {
    const resolved = resolveDead ? resolveBoard(board, geo) : { board, dead: [] };
    const score = areaScore(resolved.board, geo);
    const whiteTotal = score.white + komi;
    let winner = EMPTY;
    if (score.black > whiteTotal) winner = BLACK;
    else if (whiteTotal > score.black) winner = WHITE;

    return {
      ...score,
      komi,
      whiteTotal,
      winner,
      margin: Math.abs(score.black - whiteTotal),
      deadStones: resolved.dead,
    };
  }

  function pointLabel(idx, size) {
    const x = idx % size;
    const y = Math.floor(idx / size);
    return `${LETTERS[x]}${size - y}`;
  }

  root.Go = {
    EMPTY,
    BLACK,
    WHITE,
    LETTERS,
    makeGeometry,
    newBoard,
    opponent,
    groupAt,
    play,
    unplay,
    isSimpleEye,
    isSafeTerritory,
    areaScore,
    judge,
    pointLabel,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.Go;
  }
})(typeof self !== 'undefined' ? self : globalThis);
