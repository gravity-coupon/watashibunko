// Pure helpers for room codes, tokens, and the writer-rotation algorithm.

export function generateRoomId() {
  const chars = "ACDEFGHJKLMNPRSTUVWXYZ234567";
  let r = "";
  for (let i = 0; i < 5; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

export function generateToken() {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let r = "";
  for (let i = 0; i < 16; i++) r += chars[Math.floor(Math.random() * chars.length)];
  return r;
}

// Build a rotation of "shift" values (length = pages) so that:
//   writer(storyIndex, round) = (storyIndex + shifts[round]) mod numPlayers
// Picks the best of 200 randomized candidates against a penalty function.
export function generateRotation(np, pages) {
  if (np === 1) return new Array(pages).fill(0);
  if (np === 2) {
    const first = Math.random() < 0.5 ? 0 : 1;
    return Array.from({length: pages}, (_, i) => (first + i) % 2);
  }

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // Score: lower = better. Penalize consecutive same shifts, repeated differences, and short repeat gaps.
  function score(s) {
    let pen = 0;
    const diffCounts = {};
    for (let i = 1; i < s.length; i++) {
      if (s[i] === s[i - 1]) pen += 1000;
      const d = ((s[i] - s[i - 1]) % np + np) % np;
      diffCounts[d] = (diffCounts[d] || 0) + 1;
    }
    // Penalize when one difference dominates (same "previous writer" repeats)
    const vals = Object.values(diffCounts);
    if (vals.length > 0) pen += Math.max(...vals) * 10;
    // Bonus for using more distinct differences
    pen -= Object.keys(diffCounts).length * 5;
    // Penalize short gaps between same shift value (same player writing same story too soon)
    // Ideal gap = np. Gap < np means a player knows earlier context.
    const lastSeen = {};
    for (let i = 0; i < s.length; i++) {
      if (lastSeen[s[i]] != null) {
        const gap = i - lastSeen[s[i]];
        if (gap < np) pen += (np - gap) * 100;
      }
      lastSeen[s[i]] = i;
    }
    // Penalize shift 0 at position 0 (title creator writes first page of own story)
    if (s[0] === 0) pen += 500;
    // Penalize ABA pattern (same shift 2 apart — same player writes story again with only 1 gap)
    if (np > 2) {
      for (let i = 2; i < s.length; i++) {
        if (s[i] === s[i - 2]) pen += 200;
      }
    }
    return pen;
  }

  const base = Array.from({length: np}, (_, i) => i);
  let best = null, bestScore = Infinity;

  for (let attempt = 0; attempt < 200; attempt++) {
    const shifts = [];
    while (shifts.length < pages) {
      let perm = shuffle(base);
      if (shifts.length > 0) {
        const last = shifts[shifts.length - 1];
        const secondLast = shifts.length >= 2 ? shifts[shifts.length - 2] : -1;
        for (let r = 0; r < 30; r++) {
          // Avoid AA (same as last) and ABA (same as second-to-last) at boundary
          if (perm[0] !== last && (np <= 2 || perm[0] !== secondLast)) break;
          perm = shuffle(base);
        }
      }
      for (const v of perm) { if (shifts.length < pages) shifts.push(v); }
    }
    const s = score(shifts);
    if (s < bestScore) { bestScore = s; best = shifts; }
  }
  return best;
}

export function getWriterForStoryAtRound(si, round, np, shifts) {
  return (si + shifts[round]) % np;
}
