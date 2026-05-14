// Firebase wrapper: init, anonymous auth, and game-specific helpers.
//
// === Data model ===
// /rooms/{ROOMCODE}/
//   meta:
//     hostUid:    string   — uid of the room creator (used for abort permission)
//     numPages:   number   — total writing rounds
//     timerSec:   number   — per-phase timer (0 = no timer)
//     anonymous:  boolean  — hide authors in results
//     createdAt:  serverTimestamp
//   phase:        'lobby' | 'topic' | 'writing' | 'results'
//   round:        number   — current writing round (0-indexed)
//   timerEndsAt:  number   — epoch ms (0 = no active timer)
//   shifts:       number[] — rotation table (writer = (storyIdx + shifts[round]) % np)
//   players/{uid}:
//     name:       string
//     order:      number   — join order (0 = host)
//     joinedAt:   serverTimestamp
//   topics/{uid}: string   — title submitted by this player
//   stories: [
//     {
//       title:           string,
//       titleAuthorUid:  string,
//       parts: [{ authorUid, text, round }, ...]
//     }
//   ]
//   roundDone/{uid}: true  — set when this player submitted current round's part
//
// === Permissions model (test rules for now) ===
// Current DB rules are open-for-everyone-until-date (test mode). Production
// rules should restrict topics/{uid} and roundDone/{uid} writes to the matching
// auth.uid. Game state writes (phase, round, stories) are transactional and
// can stay broadly permitted within a room — clients race to advance state but
// only one transaction wins.

import { firebaseConfig } from './config.js';
import {
  initializeApp,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js";
import {
  getAuth, signInAnonymously, onAuthStateChanged, connectAuthEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-auth.js";
import {
  getDatabase, ref, get, set, update, remove, onValue, off,
  runTransaction, serverTimestamp, onDisconnect, connectDatabaseEmulator,
} from "https://www.gstatic.com/firebasejs/10.14.1/firebase-database.js";
import { generateRoomId, generateRotation } from './game-helpers.js';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getDatabase(app);

// Auto-connect to local emulators when served from the Firebase Hosting
// emulator (localhost:5000). Other localhost setups (e.g. python -m http.server
// on :8000) hit production — this avoids "emulator not running" errors when
// you're just iterating on UI without firing up the full emulator suite.
const useEmulators =
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1') &&
  location.port === '5000';
if (useEmulators) {
  try { connectAuthEmulator(auth, 'http://localhost:9099', { disableWarnings: true }); } catch(e) {}
  try { connectDatabaseEmulator(db, 'localhost', 9000); } catch(e) {}
  console.log('[db] using local emulators');
}

// ===================== AUTH =====================
let _uid = null;
const _authReady = new Promise((resolve) => {
  onAuthStateChanged(auth, (user) => {
    if (user) {
      _uid = user.uid;
      resolve(user.uid);
    } else {
      // Not signed in yet — kick off anonymous sign-in
      signInAnonymously(auth).catch((e) => {
        console.error('[db] anonymous sign-in failed', e);
      });
    }
  });
});

export function whenAuthed() { return _authReady; }
export function myUid() { return _uid; }

// ===================== ROOM LIFECYCLE =====================

// Create a new room and return its 5-char code. Retries on rare code collisions.
export async function createRoom({ numPages, timerSec, anonymous, hostName }) {
  const uid = await whenAuthed();
  for (let attempt = 0; attempt < 10; attempt++) {
    const roomId = generateRoomId();
    const result = await runTransaction(ref(db, `rooms/${roomId}`), (current) => {
      if (current !== null) return; // collision — abort
      return {
        meta: {
          hostUid: uid,
          numPages,
          timerSec,
          anonymous,
          createdAt: serverTimestamp(),
        },
        phase: 'lobby',
        round: 0,
        timerEndsAt: 0,
        players: {
          [uid]: { name: hostName, order: 0, joinedAt: serverTimestamp() },
        },
      };
    });
    if (result.committed) return roomId;
  }
  throw new Error('ルームコードの生成に失敗しました');
}

// Join an existing room. Returns { kind, room }:
//   kind = 'player'    — joined as a player (lobby)
//   kind = 'rejoin'    — already a player (game in progress, just re-subscribe)
//   kind = 'spectator' — game in progress and not previously a player
// Throws 'room_not_found' / 'name_taken' / 'host_name_clash'.
export async function joinRoom(roomId, name) {
  const uid = await whenAuthed();
  const roomRef = ref(db, `rooms/${roomId}`);
  const snap = await get(roomRef);
  if (!snap.exists()) throw new Error('room_not_found');
  const room = snap.val();

  // Already a player → rejoin
  if (room.players && room.players[uid]) {
    return { kind: 'rejoin', room };
  }

  // Lobby phase: add as new player (transactional, in case of races)
  if (room.phase === 'lobby') {
    // Reject if name collides with someone already in the room
    const nameTaken = room.players && Object.values(room.players).some(p => p.name === name);
    if (nameTaken) throw new Error('name_taken');

    const result = await runTransaction(ref(db, `rooms/${roomId}/players`), (players) => {
      if (players && players[uid]) return players;
      const order = players ? Object.keys(players).length : 0;
      return {
        ...(players || {}),
        [uid]: { name, order, joinedAt: serverTimestamp() },
      };
    });
    if (!result.committed) throw new Error('join_failed');
    const fresh = await get(roomRef);
    return { kind: 'player', room: fresh.val() };
  }

  // Game in progress → spectator
  // Block if name clashes with host (matches old behavior)
  const hostPlayer = room.players && Object.values(room.players).find(p => p.order === 0);
  if (hostPlayer && hostPlayer.name === name) throw new Error('host_name_clash');
  return { kind: 'spectator', room };
}

// Update this player's display name (used by host while in lobby).
export async function updatePlayerName(roomId, name) {
  const uid = await whenAuthed();
  await update(ref(db, `rooms/${roomId}/players/${uid}`), { name });
}

// Update meta fields (host only — used to sync host setup form changes).
export async function updateMeta(roomId, patch) {
  await update(ref(db, `rooms/${roomId}/meta`), patch);
}

// Remove self from lobby (player can only leave before the game starts).
export async function leaveLobby(roomId) {
  const uid = await whenAuthed();
  const phaseSnap = await get(ref(db, `rooms/${roomId}/phase`));
  if (phaseSnap.val() !== 'lobby') return;
  await runTransaction(ref(db, `rooms/${roomId}/players`), (players) => {
    if (!players || !players[uid]) return players;
    delete players[uid];
    // Renumber remaining players by their previous order
    const entries = Object.entries(players).sort((a, b) => a[1].order - b[1].order);
    entries.forEach(([k, _], i) => { players[k].order = i; });
    return players;
  });
}

// Subscribe to a room. Callback receives the full room snapshot value (or null
// if the room was deleted). Returns an unsubscribe function.
export function subscribeRoom(roomId, callback) {
  const r = ref(db, `rooms/${roomId}`);
  const listener = onValue(r, (snap) => callback(snap.val()));
  return () => off(r, 'value', listener);
}

// ===================== GAME PROGRESSION =====================

// Host kicks off the game — moves phase to 'topic' and starts the topic timer.
export async function startGame(roomId) {
  const snap = await get(ref(db, `rooms/${roomId}`));
  const room = snap.val();
  if (!room || room.phase !== 'lobby') return;
  const timerSec = room.meta.timerSec || 0;
  await update(ref(db, `rooms/${roomId}`), {
    phase: 'topic',
    timerEndsAt: timerSec > 0 ? Date.now() + timerSec * 1000 : 0,
  });
}

// Submit (or update) this player's topic. Triggers phase advancement if all done.
export async function submitTopic(roomId, topic) {
  const uid = await whenAuthed();
  await set(ref(db, `rooms/${roomId}/topics/${uid}`), topic);
  await maybeAdvanceFromTopic(roomId);
}

// Submit (or resubmit) this player's part for the current round.
// Triggers round advancement if all done.
export async function submitPart(roomId, storyIndex, round, text) {
  const uid = await whenAuthed();
  await runTransaction(ref(db, `rooms/${roomId}/stories/${storyIndex}/parts`), (parts) => {
    const arr = Array.isArray(parts) ? parts : (parts ? Object.values(parts) : []);
    const existing = arr.findIndex(p => p && p.authorUid === uid && p.round === round);
    if (existing >= 0) {
      arr[existing] = { authorUid: uid, text, round };
    } else {
      arr.push({ authorUid: uid, text, round });
    }
    return arr;
  });
  await set(ref(db, `rooms/${roomId}/roundDone/${uid}`), true);
  await maybeAdvanceFromWriting(roomId);
}

// Try to advance from 'topic' to 'writing'. Called by any client after a topic
// submit. Runs in a transaction — only one client's call will actually move the
// phase forward; others' transactions see the new phase and no-op.
async function maybeAdvanceFromTopic(roomId) {
  await runTransaction(ref(db, `rooms/${roomId}`), (room) => {
    if (!room || room.phase !== 'topic') return room;
    const players = room.players || {};
    const topics = room.topics || {};
    const uids = Object.keys(players);
    if (uids.length === 0) return room;

    // Are all topics submitted (or has the timer expired with grace)?
    const submittedCount = uids.filter(u => topics[u] && topics[u] !== '').length;
    const timerExpiredWithGrace =
      room.timerEndsAt > 0 && Date.now() > room.timerEndsAt + 3000;
    if (submittedCount < uids.length && !timerExpiredWithGrace) return room;

    // Fill in placeholders for any missing topics (when timer-driven)
    uids.forEach(u => { if (!topics[u] || topics[u] === '') topics[u] = '無題'; });

    // Build stories — ordered by player order, then shuffled so position
    // doesn't reveal authorship; also avoid title author being the first writer.
    const np = uids.length;
    const numPages = room.meta.numPages;
    const shifts = generateRotation(np, numPages);
    const ordered = uids
      .map(u => ({ uid: u, order: players[u].order, title: topics[u] || '無題' }))
      .sort((a, b) => a.order - b.order);

    let stories = ordered.map(p => ({
      title: p.title,
      titleAuthorUid: p.uid,
      parts: [],
    }));
    for (let attempt = 0; attempt < 50; attempt++) {
      for (let i = stories.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [stories[i], stories[j]] = [stories[j], stories[i]];
      }
      const collision = stories.some((s, si) => {
        const writerOrder = (si + shifts[0]) % np;
        return ordered[writerOrder].uid === s.titleAuthorUid;
      });
      if (!collision) break;
    }

    room.phase = 'writing';
    room.round = 0;
    room.shifts = shifts;
    room.stories = stories;
    room.topics = topics;
    room.roundDone = null;
    room.timerEndsAt = room.meta.timerSec > 0
      ? Date.now() + room.meta.timerSec * 1000
      : 0;
    return room;
  });
}

// Try to advance the writing round (or finish the game). Called after each part submit.
async function maybeAdvanceFromWriting(roomId) {
  await runTransaction(ref(db, `rooms/${roomId}`), (room) => {
    if (!room || room.phase !== 'writing') return room;
    const players = room.players || {};
    const roundDone = room.roundDone || {};
    const allUids = Object.keys(players);
    // Active players = not kicked. Only these count toward round completion;
    // kicked players' would-be slots are simply omitted from the story.
    const activeUids = allUids.filter(u => !players[u].kicked);
    if (activeUids.length === 0) return room;

    const doneCount = activeUids.filter(u => roundDone[u] === true).length;
    const timerExpiredWithGrace =
      room.timerEndsAt > 0 && Date.now() > room.timerEndsAt + 3000;
    if (doneCount < activeUids.length && !timerExpiredWithGrace) return room;

    // Fill in placeholder parts for any active players who didn't submit before
    // the timer expired. Kicked players are NOT filled in — that's the whole
    // point of the kick (their story slot stays empty, story gets shorter).
    if (doneCount < activeUids.length) {
      // `np` is total player count (kicked included): shifts were computed
      // against this, and player order indices are stable, so we keep using it.
      const np = allUids.length;
      activeUids.forEach(u => {
        if (!roundDone[u]) {
          const writerOrder = players[u].order;
          for (let si = 0; si < np; si++) {
            if ((si + room.shifts[room.round]) % np === writerOrder) {
              const parts = room.stories[si].parts || [];
              const alreadyHas = parts.some(p =>
                p && p.authorUid === u && p.round === room.round);
              if (!alreadyHas) {
                parts.push({ authorUid: u, text: '……', round: room.round });
                room.stories[si].parts = parts;
              }
              break;
            }
          }
          roundDone[u] = true;
        }
      });
      room.roundDone = roundDone;
    }

    const next = room.round + 1;
    if (next >= room.meta.numPages) {
      room.phase = 'results';
      room.timerEndsAt = 0;
    } else {
      room.round = next;
      room.roundDone = null;
      room.timerEndsAt = room.meta.timerSec > 0
        ? Date.now() + room.meta.timerSec * 1000
        : 0;
    }
    return room;
  });
}

// Called by any client when the local clock detects the timer has expired
// (plus a small grace). Triggers the same advancement transaction the
// submit handlers do; only one client's call effectively moves things forward.
export async function pokeTimerExpiry(roomId, phase) {
  if (phase === 'topic') await maybeAdvanceFromTopic(roomId);
  else if (phase === 'writing') await maybeAdvanceFromWriting(roomId);
}

// Host kicks a player by flagging them as kicked. Their submissions stop
// counting toward round advancement and the timer-driven placeholder filler
// skips them, so their would-be parts are omitted from the story (the story
// just becomes shorter by that much). We trigger an advance check immediately
// in case the kicked player was the only one blocking progression.
export async function kickPlayer(roomId, uid) {
  await set(ref(db, `rooms/${roomId}/players/${uid}/kicked`), true);
  await maybeAdvanceFromWriting(roomId);
}

// Host aborts the game mid-play — moves to results immediately.
export async function abortGame(roomId) {
  await update(ref(db, `rooms/${roomId}`), {
    phase: 'results',
    timerEndsAt: 0,
  });
}

// Host disbands the room (only valid from lobby). Removes the room entirely.
export async function disbandRoom(roomId) {
  await remove(ref(db, `rooms/${roomId}`));
}

// ===================== HELPERS =====================

// Return players sorted by their `order` field. Used as the canonical player list.
export function playersSorted(room) {
  if (!room || !room.players) return [];
  return Object.entries(room.players)
    .map(([uid, p]) => ({ uid, ...p }))
    .sort((a, b) => a.order - b.order);
}

// Resolve a player order index to a uid+name.
export function playerAtOrder(room, order) {
  return playersSorted(room).find(p => p.order === order);
}
