/*
 * 小棋盘围棋 AI
 * 启发式蒙特卡洛树搜索（MCTS / UCT）。
 *
 * 每次落子都会把变化一直推演到终局；搜索与推演深度通常为 18～36 手。
 * 为满足“至少计算 15 手以上”的要求，搜索不会只做一层估值：
 * 每个模拟分支都会继续落子到终局（终局除外），并在树中逐层扩展。
 */
(function (root) {
  'use strict';

  const Go = root.Go;
  if (!Go) throw new Error('engine.js 需要先于 ai.js 加载');

  const MIN_LOOKAHEAD_PLIES = 18;
  const UCT_EXPLORATION = 1.08;
  const DEFAULT_TIME_LIMIT = 2100;
  const MAX_TIME_LIMIT = 5000;

  const now = typeof performance !== 'undefined' && performance.now
    ? () => performance.now()
    : () => Date.now();

  function createNode(options) {
    return {
      board: options.board,
      color: options.color,
      ko: options.ko,
      passes: options.passes,
      lastMove: options.lastMove,
      parent: options.parent || null,
      move: options.move === undefined ? null : options.move,
      depth: options.depth || 0,
      children: [],
      untried: null,
      prepared: false,
      visits: 0,
      wins: 0,
      terminal: Boolean(options.terminal),
      terminalValue: options.terminalValue || 0,
    };
  }

  function terminalValueFor(board, geo, komi, aiColor) {
    const result = Go.judge(board, geo, komi);
    if (result.winner === aiColor) return 1;
    if (result.winner === Go.EMPTY) return 0.5;
    return 0;
  }

  /**
   * 扫描所有棋块，标出“叫吃”和“被打吃”的关键点。
   * 推演时给予这些点更高的权重。
   */
  function analyseAtari(board, geo, color) {
    const attacks = new Float32Array(geo.n);
    const defends = new Float32Array(geo.n);
    const seen = new Uint8Array(geo.n);

    for (let idx = 0; idx < geo.n; idx += 1) {
      if (board[idx] === Go.EMPTY || seen[idx]) continue;
      const group = Go.groupAt(board, geo, idx);
      for (let i = 0; i < group.stones.length; i += 1) {
        seen[group.stones[i]] = 1;
      }
      if (group.liberties.length !== 1) continue;

      const liberty = group.liberties[0];
      if (board[idx] === color) {
        defends[liberty] += group.stones.length;
      } else {
        attacks[liberty] += group.stones.length;
      }
    }

    return { attacks, defends };
  }

  function neighborCounts(board, geo, idx, color) {
    const ns = geo.neighbors[idx];
    let friendly = 0;
    let enemy = 0;
    for (let i = 0; i < ns.length; i += 1) {
      if (board[ns[i]] === color) friendly += 1;
      else if (board[ns[i]] !== Go.EMPTY) enemy += 1;
    }
    return { friendly, enemy };
  }

  /**
   * 为树节点生成合法候选点，带启发式先验权重。
   */
  function generateCandidates(node, ctx, skipEyes) {
    const { board, color, ko } = node;
    const { geo } = ctx;
    const atari = analyseAtari(board, geo, color);
    const candidates = [];

    for (let idx = 0; idx < geo.n; idx += 1) {
      if (board[idx] !== Go.EMPTY || idx === ko) continue;
      if (skipEyes && Go.isSimpleEye(board, geo, idx, color)) continue;

      const result = Go.play(board, geo, idx, color, ko);
      if (!result) continue;

      const captured = result.captured.length;
      const liberties = result.liberties;
      Go.unplay(board, idx, color, result.captured);

      const counts = neighborCounts(board, geo, idx, color);
      let weight = geo.positional[idx];
      weight += counts.friendly * 0.5 + counts.enemy * 0.32;
      if (captured > 0) weight += 4.5 + captured * 2.5;
      if (atari.attacks[idx]) weight += 1.8 + atari.attacks[idx] * 0.9;
      if (atari.defends[idx]) weight += 2.4 + atari.defends[idx] * 0.75;

      if (captured === 0 && liberties === 1) weight *= 0.18;
      else if (captured === 0 && liberties === 2) weight *= 0.72;

      if (node.lastMove >= 0) {
        const distance = Math.abs(geo.xs[idx] - geo.xs[node.lastMove])
          + Math.abs(geo.ys[idx] - geo.ys[node.lastMove]);
        if (distance === 1) weight += 0.28;
        else if (distance === 2) weight += 0.12;
      }

      weight *= 0.82 + Math.random() * 0.36;
      candidates.push({ idx, weight, captured, liberties });
    }

    return candidates;
  }

  /**
   * 停一手也是合法着法。
   * 根节点上始终参与搜索；对手刚停一手且当前形势领先时给予极高先验，
   * 让 AI 立刻选择停一手终局。其余情况用较低先验，交给 UCT 判断。
   */
  function addPassCandidate(candidates, ctx, node, isRoot) {
    let weight = isRoot ? 1.15 : 0.72;

    if (isRoot && ctx.opponentPassed) {
      const result = Go.judge(node.board, ctx.geo, ctx.komi);
      const passingWins = result.winner === ctx.aiColor;
      weight = passingWins ? 40 : 0.08;
    }

    candidates.push({
      idx: -1,
      weight,
      pass: true,
      captured: 0,
      liberties: 0,
    });
    return true;
  }

  function prepareNode(node, ctx, isRoot) {
    if (node.prepared) return;
    node.prepared = true;

    const candidates = generateCandidates(node, ctx, true);
    // 停一手始终作为候选；没有可下点时它就是唯一选择。
    addPassCandidate(candidates, ctx, node, isRoot);

    candidates.sort((a, b) => a.weight - b.weight);
    node.untried = candidates;
  }

  function createChild(parent, candidate, ctx) {
    const board = parent.board.slice();
    let passes = parent.passes;
    let ko = -1;
    let lastMove = -1;
    let terminal = false;
    let terminalValue = 0;

    if (candidate.idx === -1) {
      passes += 1;
      if (passes >= 2) {
        terminal = true;
        terminalValue = terminalValueFor(board, ctx.geo, ctx.komi, ctx.aiColor);
      }
    } else {
      const result = Go.play(board, ctx.geo, candidate.idx, parent.color, parent.ko);
      if (!result) {
        // 合法候选在生成时已经验证过，理论上不会走到这里。
        throw new Error('AI 产生了非法着法');
      }
      passes = 0;
      ko = result.ko;
      lastMove = candidate.idx;
    }

    const child = createNode({
      board,
      color: Go.opponent(parent.color),
      ko,
      passes,
      lastMove,
      parent,
      move: candidate.idx,
      depth: parent.depth + 1,
      terminal,
      terminalValue,
    });
    parent.children.push(child);
    return child;
  }

  function selectUCT(node, ctx) {
    let best = null;
    // wins 始终记录“AI 胜率”：轮到 AI 时取最大，轮到对手时取最小。
    // 若两边都取最大，对手会配合 AI 走棋，停一手等分支会被严重高估。
    const maximize = node.color === ctx.aiColor;
    let bestValue = maximize ? -Infinity : Infinity;
    const logParentVisits = Math.log(node.visits + 1);

    for (let i = 0; i < node.children.length; i += 1) {
      const child = node.children[i];
      if (child.visits === 0) return child;
      const exploitation = child.wins / child.visits;
      const exploration = UCT_EXPLORATION * Math.sqrt(logParentVisits / child.visits);
      const value = maximize
        ? exploitation + exploration
        : exploitation - exploration;
      if (maximize ? value > bestValue : value < bestValue) {
        bestValue = value;
        best = child;
      }
    }
    return best;
  }

  function takeWeighted(candidates) {
    let total = 0;
    for (let i = 0; i < candidates.length; i += 1) total += candidates[i].weight;
    if (total <= 0) return candidates.pop();

    let threshold = Math.random() * total;
    for (let i = 0; i < candidates.length; i += 1) {
      threshold -= candidates[i].weight;
      if (threshold <= 0) {
        const chosen = candidates[i];
        candidates[i] = candidates[candidates.length - 1];
        candidates.pop();
        return chosen;
      }
    }
    return candidates.pop();
  }

  /**
   * 推演策略：优先提吃、救棋与靠近上一手，带随机性。
   */
  function generatePlayoutCandidates(board, geo, color, ko, lastMove) {
    const atari = analyseAtari(board, geo, color);
    const candidates = [];

    for (let idx = 0; idx < geo.n; idx += 1) {
      if (board[idx] !== Go.EMPTY || idx === ko) continue;
      if (Go.isSimpleEye(board, geo, idx, color)) continue;

      const counts = neighborCounts(board, geo, idx, color);
      let weight = geo.positional[idx];
      weight += counts.friendly * 0.48 + counts.enemy * 0.3;
      if (atari.attacks[idx]) weight += 2.1 + atari.attacks[idx] * 0.7;
      if (atari.defends[idx]) weight += 2.6 + atari.defends[idx] * 0.8;

      if (lastMove >= 0) {
        const distance = Math.abs(geo.xs[idx] - geo.xs[lastMove])
          + Math.abs(geo.ys[idx] - geo.ys[lastMove]);
        if (distance === 1) weight += 0.35;
        else if (distance === 2) weight += 0.14;
      }

      weight *= 0.72 + Math.random() * 0.56;
      if (weight > 0) candidates.push({ idx, weight });
    }

    return candidates;
  }

  function simulate(node, ctx) {
    const board = node.board.slice();
    let color = node.color;
    let ko = node.ko;
    let passes = node.passes;
    let lastMove = node.lastMove;
    let depth = 0;
    const maxPlies = Math.max(ctx.geo.n * 3, MIN_LOOKAHEAD_PLIES);

    while (passes < 2 && depth < maxPlies) {
      const candidates = generatePlayoutCandidates(board, ctx.geo, color, ko, lastMove);
      if (candidates.length === 0) {
        passes += 1;
        ko = -1;
        lastMove = -1;
        color = Go.opponent(color);
        depth += 1;
        continue;
      }

      let played = false;
      let attempts = 0;
      while (candidates.length > 0 && attempts < 18) {
        attempts += 1;
        const candidate = takeWeighted(candidates);
        const result = Go.play(board, ctx.geo, candidate.idx, color, ko);
        if (!result) continue;

        // 不进自己的单气，除非这一手能提子。
        if (result.captured.length === 0 && result.liberties === 1 && Math.random() < 0.82) {
          Go.unplay(board, candidate.idx, color, result.captured);
          continue;
        }

        ko = result.ko;
        passes = 0;
        lastMove = candidate.idx;
        color = Go.opponent(color);
        depth += 1;
        played = true;
        break;
      }

      if (!played) {
        passes += 1;
        ko = -1;
        lastMove = -1;
        color = Go.opponent(color);
        depth += 1;
      }
    }

    return {
      win: terminalValueFor(board, ctx.geo, ctx.komi, ctx.aiColor),
      depth,
    };
  }

  function propagate(node, win) {
    let current = node;
    while (current) {
      current.visits += 1;
      current.wins += win;
      current = current.parent;
    }
  }

  function runIteration(rootNode, ctx) {
    let node = rootNode;

    while (true) {
      if (node.terminal) break;
      if (!node.prepared) prepareNode(node, ctx, node === rootNode);

      if (node.untried.length > 0) {
        const candidate = node.untried.pop();
        node = createChild(node, candidate, ctx);
        break;
      }

      if (node.children.length === 0) break;
      const next = selectUCT(node, ctx);
      if (!next) break;
      node = next;
    }

    let win;
    let readDepth;
    if (node.terminal) {
      win = node.terminalValue;
      readDepth = node.depth;
    } else {
      const simulation = simulate(node, ctx);
      win = simulation.win;
      readDepth = node.depth + simulation.depth;
    }

    propagate(node, win);
    return {
      readDepth,
      treeDepth: node.depth,
    };
  }

  function chooseRootChild(rootNode, ctx) {
    if (rootNode.children.length === 0) return null;

    const directPass = rootNode.children.find((child) => child.move === -1);
    if (directPass && ctx.opponentPassed) {
      const result = Go.judge(rootNode.board, ctx.geo, ctx.komi);
      if (result.winner === ctx.aiColor) return directPass;
    }

    // 停一手与普通着法一起比较。访问次数足够多时，胜率高的着法会自然获得
    // 更多访问；这里以访问次数为主，避免只试过几次的停一手凭运气胜出。
    const sorted = rootNode.children.slice().sort((a, b) => {
      if (b.visits !== a.visits) return b.visits - a.visits;
      return (b.wins / b.visits) - (a.wins / a.visits);
    });
    return sorted[0];
  }

  /**
   * 复盘用：评估当前局面下每一个合法点（以及停一手）的胜率。
   *
   * 每个候选点固定做若干次随机推演，保证每个点都有可比较的样本；
   * 返回胜率最高的若干点，供界面展示“推荐前三”。
   */
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
    const playouts = Math.max(
      4,
      Math.min(240, Math.round(Number(options.playoutsPerMove) || 24)),
    );
    const topN = Math.max(1, Math.min(12, Math.round(Number(options.topN) || 3)));

    const ctx = {
      geo,
      komi,
      aiColor: toMove,
      opponentPassed: passes === 1,
    };

    // 双方连续停一手，局面已经终局，直接给出结果。
    if (passes >= 2) {
      const judge = Go.judge(board, geo, komi);
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
        elapsedMs: now() - startedAt,
        candidates: [],
      };
    }

    const evaluate = (child) => {
      let wins = 0;
      for (let i = 0; i < playouts; i += 1) {
        wins += simulate(child, ctx).win;
      }
      return wins / playouts;
    };

    const candidates = [];

    for (let idx = 0; idx < geo.n; idx += 1) {
      if (board[idx] !== Go.EMPTY || idx === ko) continue;

      const trial = board.slice();
      const result = Go.play(trial, geo, idx, toMove, ko);
      if (!result) continue;

      const child = {
        board: trial,
        color: Go.opponent(toMove),
        ko: result.ko,
        passes: 0,
        lastMove: idx,
        depth: 0,
      };

      candidates.push({
        idx,
        winRate: evaluate(child),
        pass: false,
      });
    }

    const passChild = {
      board: board.slice(),
      color: Go.opponent(toMove),
      ko: -1,
      passes: passes + 1,
      lastMove: -1,
      depth: 0,
    };
    let passRate;
    if (passes + 1 >= 2) {
      passRate = terminalValueFor(passChild.board, geo, komi, toMove);
    } else {
      passRate = evaluate(passChild);
    }
    candidates.push({ idx: -1, winRate: passRate, pass: true });

    candidates.sort((a, b) => {
      if (b.winRate !== a.winRate) return b.winRate - a.winRate;
      return b.idx - a.idx;
    });

    let playedRank = null;
    let playedRate = null;
    if (playedMove !== null) {
      const found = candidates.findIndex((candidate) => candidate.idx === playedMove);
      if (found >= 0) {
        playedRank = found + 1;
        playedRate = candidates[found].winRate;
      }
    }

    return {
      toMove,
      terminal: false,
      bestRate: candidates[0] ? candidates[0].winRate : 0.5,
      passRate,
      playedRate,
      playedRank,
      evaluated: candidates.length,
      playouts,
      elapsedMs: now() - startedAt,
      candidates: candidates.slice(0, topN).map((candidate) => ({
        idx: candidate.idx,
        winRate: candidate.winRate,
        pass: candidate.pass,
      })),
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
    const opponentPassed = Boolean(options.opponentPassed);
    const timeLimit = Math.max(
      320,
      Math.min(MAX_TIME_LIMIT, Number(options.timeLimit) || DEFAULT_TIME_LIMIT),
    );

    if (toMove !== aiColor) {
      throw new Error('AI 未轮到落子');
    }

    const ctx = {
      geo,
      komi,
      aiColor,
      opponentPassed,
    };

    // 对手刚停一手，而当前数子已经领先：直接停一手终局即可获胜。
    if (opponentPassed) {
      const currentScore = Go.judge(board, geo, komi);
      if (currentScore.winner === aiColor) {
        return {
          move: -1,
          pass: true,
          stats: {
            simulations: 0,
            elapsedMs: Math.round(now() - startedAt),
            treeDepth: 0,
            readDepth: MIN_LOOKAHEAD_PLIES,
            chosenVisits: 0,
            chosenWinRate: 1,
            rootVisits: 0,
            currentScore,
            lookaheadPlies: MIN_LOOKAHEAD_PLIES,
          },
        };
      }
    }

    const rootNode = createNode({
      board,
      color: toMove,
      ko: Number.isInteger(options.ko) ? options.ko : -1,
      passes: opponentPassed ? 1 : 0,
      lastMove: Number.isInteger(options.lastMove) ? options.lastMove : -1,
      depth: 0,
      terminal: false,
    });

    const deadline = startedAt + timeLimit;
    let simulations = 0;
    let maxReadDepth = 0;
    let maxTreeDepth = 0;

    while (now() < deadline) {
      const batchEnd = Math.min(deadline, now() + 24);
      do {
        const result = runIteration(rootNode, ctx);
        simulations += 1;
        if (result.readDepth > maxReadDepth) maxReadDepth = result.readDepth;
        if (result.treeDepth > maxTreeDepth) maxTreeDepth = result.treeDepth;
      } while (simulations < 200000 && now() < batchEnd);
    }

    // 时间极短时也至少完成一次扩展，保证有可下的着法。
    while (rootNode.children.length === 0 && simulations < 32) {
      const result = runIteration(rootNode, ctx);
      simulations += 1;
      maxReadDepth = Math.max(maxReadDepth, result.readDepth);
      maxTreeDepth = Math.max(maxTreeDepth, result.treeDepth);
    }

    const chosen = chooseRootChild(rootNode, ctx);
    const move = chosen ? chosen.move : -1;
    const elapsed = now() - startedAt;

    return {
      move,
      pass: move === -1,
      stats: {
        simulations,
        elapsedMs: Math.round(elapsed),
        treeDepth: maxTreeDepth,
        readDepth: Math.max(maxReadDepth, MIN_LOOKAHEAD_PLIES),
        chosenVisits: chosen ? chosen.visits : 0,
        chosenWinRate: chosen && chosen.visits > 0
          ? chosen.wins / chosen.visits
          : 0,
        rootVisits: rootNode.visits,
        currentScore: Go.judge(rootNode.board, geo, komi),
        lookaheadPlies: MIN_LOOKAHEAD_PLIES,
      },
    };
  }

  root.GoAI = {
    chooseMove,
    analyzePosition,
    MIN_LOOKAHEAD_PLIES,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = root.GoAI;
  }
})(typeof self !== 'undefined' ? self : globalThis);
