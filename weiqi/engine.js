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

  function makeGeometry(size) {
    if (geometryCache[size]) return geometryCache[size];

    const n = size * size;
    const neighbors = Array.from({ length: n }, () => []);
    const diagonals = Array.from({ length: n }, () => []);
    const xs = new Uint8Array(n);
    const ys = new Uint8Array(n);
    const edgeDistance = new Uint8Array(n);
    const positional = new Float32Array(n);
    const center = (size - 1) / 2;
    const maxCenterDistance = Math.max(1, Math.hypot(center, center));

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        const idx = y * size + x;
        xs[idx] = x;
        ys[idx] = y;

        if (x > 0) neighbors[idx].push(idx - 1);
        if (x < size - 1) neighbors[idx].push(idx + 1);
        if (y > 0) neighbors[idx].push(idx - size);
        if (y < size - 1) neighbors[idx].push(idx + size);

        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dx = -1; dx <= 1; dx += 1) {
            if (dx === 0 && dy === 0) continue;
            if (dx !== 0 && dy !== 0) {
              const nx = x + dx;
              const ny = y + dy;
              if (nx >= 0 && nx < size && ny >= 0 && ny < size) {
                diagonals[idx].push(ny * size + nx);
              }
            }
          }
        }

        const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
        edgeDistance[idx] = edge;
        let value = edge === 0 ? 0.32 : edge === 1 ? 1.02 : 1.5;
        const centerDistance = Math.hypot(x - center, y - center) / maxCenterDistance;
        value += (1 - centerDistance) * 0.4;
        positional[idx] = value;
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

  function judge(board, geo, komi) {
    const score = areaScore(board, geo);
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
    };
  }

  function pointLabel(idx, size) {
    const x = idx % size;
    const y = Math.floor(idx / size);
    return `${LETTERS[x]}${size - y}`;
  }

  function coordinateText(idx, size) {
    return pointLabel(idx, size);
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
    areaScore,
    judge,
    pointLabel,
    coordinateText,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.Go;
  }
})(typeof self !== 'undefined' ? self : globalThis);
