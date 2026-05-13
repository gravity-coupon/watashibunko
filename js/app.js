// Main app: state, screens, event handlers. All networking goes through db.js.
//
// Migration notes (P2P → Firebase RTDB):
// - There is no longer a persistent "host" connection — every client subscribes
//   directly to /rooms/{rid} and reacts to snapshot changes.
// - The host is just the room creator (meta.hostUid). They get the abort/start
//   buttons but otherwise behave like any other player.
// - Reconnection is handled by the Firebase SDK — when you come back, the
//   listener delivers the current room state and we re-render.
// - Identity is the Firebase Anonymous Auth uid, stored by the SDK in
//   IndexedDB. Same browser = same uid across reloads.

import { generateRandomTopic } from './topics-gen.js';
import { getWriterForStoryAtRound } from './game-helpers.js';
import { STORY_THEMES, PLAYER_COLORS, TIMER_OPTIONS } from './themes.js';
import { escHtml, dbg, initDebug, setDebugEnabled, isDebugOn } from './utils.js';
import {
  whenAuthed, myUid,
  createRoom, joinRoom as dbJoinRoom, leaveLobby as dbLeaveLobby, subscribeRoom,
  updatePlayerName, updateMeta,
  startGame as dbStartGame,
  submitTopic as dbSubmitTopic, submitPart as dbSubmitPart,
  pokeTimerExpiry, abortGame as dbAbortGame, disbandRoom,
  playersSorted, playerAtOrder,
} from './db.js';

// ===================== STATE =====================
let roomId = null;
let myKind = 'none';          // 'host' | 'player' | 'spectator' | 'none'
let currentRoom = null;       // last room snapshot
let unsubscribeRoom = null;

// UI state (driven by DOM; persisted in storage only where useful)
let currentScreenName = 'title';
let formNumPages = 4;         // host setup form (mirrored to DB once room exists)
let formTimerSec = 0;
let formAnonymous = false;
let myTopicSubmitted = false;
let mySubmittedRound = -1;       // round number I optimistically submitted for
let _lastRenderedRound = -1;     // round currently shown on the writing screen
let myStoryIndex = -1;
let currentStoryView = 0;
let currentTheme = STORY_THEMES[0];
let _autoSubmittedTimerRound = -2;  // dedupe timer-driven auto-submit
let _autoSubmittedTimerTopic = false;

const CHAR_LIMIT = 100;
const SS_TOPIC_DRAFT = 'jarebon_topic_draft';
const SS_PART_DRAFT = 'jarebon_part_draft';
const LS_NAME = 'jarebon_name';
const LS_LASTROOM = 'jarebon_lastroom';
const LS_THEME = 'jarebon_theme';
const LS_FONT = 'jarebon_storyfont';

// ===================== UTILITIES =====================
function isHost() { return myKind === 'host'; }
function isSpectator() { return myKind === 'spectator'; }
function myPlayer() {
  if (!currentRoom || !currentRoom.players) return null;
  return currentRoom.players[myUid()];
}
function myOrder() {
  const p = myPlayer();
  return p ? p.order : -1;
}
function numPlayers() { return playersSorted(currentRoom).length; }
function nameOfUid(uid) {
  if (!currentRoom || !currentRoom.players || !currentRoom.players[uid]) return '';
  return currentRoom.players[uid].name;
}
function orderOfUid(uid) {
  if (!currentRoom || !currentRoom.players || !currentRoom.players[uid]) return -1;
  return currentRoom.players[uid].order;
}

function saveLastRoom(rid, name) {
  try { localStorage.setItem(LS_LASTROOM, JSON.stringify({ roomId: rid, name })); } catch(e) {}
}
function loadLastRoom() {
  try { const s = localStorage.getItem(LS_LASTROOM); return s ? JSON.parse(s) : null; } catch(e) { return null; }
}
function clearLastRoom() {
  try { localStorage.removeItem(LS_LASTROOM); } catch(e) {}
}

function saveDraftValue(key, value) {
  try { sessionStorage.setItem(key, value); } catch(e) {}
}
function loadDraftValue(key) {
  try { return sessionStorage.getItem(key) || ''; } catch(e) { return ''; }
}
function clearDraftValue(key) {
  try { sessionStorage.removeItem(key); } catch(e) {}
}

// Part draft is round + story keyed: we should NOT restore last round's text
// when a new round begins, but we DO want to survive a mid-round reload.
function savePartDraft(text, round, storyIndex) {
  try {
    sessionStorage.setItem(SS_PART_DRAFT, JSON.stringify({ text, round, storyIndex }));
  } catch(e) {}
}
function loadPartDraft(round, storyIndex) {
  try {
    const s = sessionStorage.getItem(SS_PART_DRAFT);
    if (!s) return '';
    const d = JSON.parse(s);
    if (d.round === round && d.storyIndex === storyIndex) return d.text || '';
    return '';
  } catch(e) { return ''; }
}

// ===================== SCREEN MANAGEMENT =====================
const screens = ['title', 'host', 'join', 'lobby', 'topic', 'writing', 'results'];
function showScreen(name) {
  currentScreenName = name;
  screens.forEach(s => document.getElementById('screen-' + s).classList.toggle('hidden', s !== name));
  updateRoomCodeBadge();
  if (name === 'title') { updateRejoinButton(); checkForUpdate(); }
}

function updateRoomCodeBadge() {
  const badge = document.getElementById('room-code-badge');
  if (roomId && currentScreenName !== 'title' && currentScreenName !== 'join' && currentScreenName !== 'host') {
    badge.textContent = '🔑 ' + roomId;
    badge.style.display = 'block';
  } else {
    badge.style.display = 'none';
  }
}

function copyRoomCodeBadge() {
  if (!roomId) return;
  navigator.clipboard.writeText(roomId).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = roomId; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
  });
  const badge = document.getElementById('room-code-badge');
  const orig = badge.textContent;
  badge.textContent = '✓ コピー済み';
  setTimeout(() => { badge.textContent = orig; }, 1500);
}

function copyRoomCode() {
  const code = document.getElementById('host-room-code').textContent;
  navigator.clipboard.writeText(code).then(() => {
    showRoomCopyFeedback('コピーしました！');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = code; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    showRoomCopyFeedback('コピーしました！');
  });
}

function showRoomCopyFeedback(msg) {
  const el = document.getElementById('room-copy-feedback');
  el.textContent = msg; el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; }, 2000);
}

// ===================== RESET / NAVIGATION =====================
function unsubFromRoom() {
  if (unsubscribeRoom) { unsubscribeRoom(); unsubscribeRoom = null; }
}

function resetLocalGameState() {
  currentRoom = null;
  myKind = 'none';
  myTopicSubmitted = false;
  mySubmittedRound = -1;
  _lastRenderedRound = -1;
  _enteredPhase = null;
  myStoryIndex = -1;
  currentStoryView = 0;
  _autoSubmittedTimerRound = -2;
  _autoSubmittedTimerTopic = false;
  stopLocalTimerTick();
}

// Tear down local subscriptions + state. Always call this BEFORE any DB
// delete/leave write, so we don't notify ourselves about an action we just
// initiated (which would surface as the "部屋が解散されました" alert).
function _localCleanup() {
  unsubFromRoom();
  roomId = null;
  resetLocalGameState();
  clearLastRoom();
  clearDraftValue(SS_TOPIC_DRAFT);
  clearDraftValue(SS_PART_DRAFT);
}

async function backToTitle() {
  const shouldDisband = isHost() && currentRoom && currentRoom.phase === 'lobby';
  const rid = roomId;
  _localCleanup();
  if (shouldDisband && rid) {
    try { await disbandRoom(rid); } catch(e) {}
  }
  showScreen('title');
}

async function leaveLobby() {
  const rid = roomId;
  _localCleanup();
  if (rid) {
    try { await dbLeaveLobby(rid); } catch(e) {}
  }
  showScreen('title');
}

// ===================== TITLE / REJOIN =====================
function updateRejoinButton() {
  const btn = document.getElementById('rejoin-btn');
  const last = loadLastRoom();
  if (last && last.roomId && last.name) {
    btn.textContent = last.roomId;
    btn.disabled = false;
    btn.style.display = 'block';
  } else {
    btn.style.display = 'none';
  }
}

async function rejoinLastRoom() {
  const last = loadLastRoom();
  if (!last || !last.roomId || !last.name) return;
  gtag('event', 'rejoin_room', { room_id: last.roomId });
  const btn = document.getElementById('rejoin-btn');
  const orig = btn.textContent;
  btn.textContent = '接続中...';
  btn.disabled = true;
  try {
    await joinAndSubscribe(last.roomId, last.name);
  } catch(e) {
    btn.textContent = orig;
    btn.disabled = false;
    clearLastRoom();
    updateRejoinButton();
  }
}

// ===================== HOST SETUP =====================
async function showHostSetup() {
  await whenAuthed();
  const hostName = (function() { try { return localStorage.getItem(LS_NAME) || ''; } catch(e) { return ''; } })() || 'ホスト';
  formNumPages = 4;
  formTimerSec = 0;
  formAnonymous = false;
  myKind = 'host';

  try {
    roomId = await createRoom({
      numPages: formNumPages,
      timerSec: formTimerSec,
      anonymous: formAnonymous,
      hostName,
    });
  } catch(e) {
    alert('部屋作成に失敗しました: ' + (e.message || e));
    myKind = 'none';
    showScreen('title');
    return;
  }
  saveLastRoom(roomId, hostName);
  gtag('event', 'create_room', { room_id: roomId });

  document.getElementById('host-room-code').textContent = roomId;
  document.getElementById('host-name').value = hostName;
  document.getElementById('anonymous-mode').checked = false;
  renderPageSelect();
  renderTimerSelect();
  showScreen('host');
  wireUpHostScreen();
  subscribeAndDispatch();
}

// Set up the host setup screen's reactive inputs. Called from both the
// initial `showHostSetup` path and the reload path (handleRoomUpdate's first
// entry to the host screen) — without this, reloading on the host screen
// leaves the name field empty and the oninput handler unwired, which keeps
// the start button disabled forever.
function wireUpHostScreen() {
  const nameEl = document.getElementById('host-name');
  // Seed the input only when empty (preserve any typing in progress)
  if (!nameEl.value) {
    const me = myPlayer();
    if (me && me.name) nameEl.value = me.name;
  }
  const anonEl = document.getElementById('anonymous-mode');
  anonEl.checked = !!(currentRoom && currentRoom.meta && currentRoom.meta.anonymous);

  nameEl.oninput = () => {
    const v = nameEl.value.trim() || 'ホスト';
    saveLastRoom(roomId, v);
    try { localStorage.setItem(LS_NAME, v); } catch(e) {}
    updatePlayerName(roomId, v).catch(() => {});
  };
  anonEl.onchange = () => {
    formAnonymous = anonEl.checked;
    updateMeta(roomId, { anonymous: formAnonymous }).catch(() => {});
  };
}

function renderPageSelect() {
  const cont = document.getElementById('page-select');
  cont.innerHTML = '';
  [3, 4, 5, 6, 8, 10, 12, 16].forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'page-select-btn' + (n === formNumPages ? ' active' : '');
    btn.textContent = n;
    btn.onclick = () => {
      formNumPages = n;
      renderPageSelect();
      updateMeta(roomId, { numPages: n }).catch(() => {});
    };
    cont.appendChild(btn);
  });
}

function renderTimerSelect() {
  const cont = document.getElementById('timer-select');
  cont.innerHTML = '';
  TIMER_OPTIONS.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'timer-option' + (opt.sec === formTimerSec ? ' active' : '');
    btn.innerHTML = '<span class="timer-label">' + opt.label + '</span><span class="timer-desc"><strong>' + opt.name + '</strong> ' + opt.desc + '</span>';
    btn.onclick = () => {
      formTimerSec = opt.sec;
      renderTimerSelect();
      updateMeta(roomId, { timerSec: opt.sec }).catch(() => {});
    };
    cont.appendChild(btn);
  });
}

function renderHostPlayers(room) {
  const list = document.getElementById('host-player-list');
  list.innerHTML = '';
  const ps = playersSorted(room);
  ps.forEach((p, i) => {
    const span = document.createElement('span');
    span.className = 'badge ' + (i === 0 ? 'badge-gold' : 'badge-green');
    span.textContent = (i === 0 ? '👑 ' : '') + p.name;
    list.appendChild(span);
  });
  document.getElementById('host-player-count').textContent = ps.length;
  const nameInputVal = document.getElementById('host-name').value.trim();
  const canStart = ps.length >= 2 && nameInputVal !== '';
  document.getElementById('start-btn').disabled = !canStart;
  document.getElementById('start-btn').textContent = 'ゲーム開始（' + ps.length + '人）';
  document.getElementById('start-hint').classList.toggle('hidden', ps.length >= 2);
}

function renderLobbyPlayers(room) {
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';
  playersSorted(room).forEach((p, i) => {
    const span = document.createElement('span');
    span.className = 'badge ' + (i === 0 ? 'badge-gold' : 'badge-green');
    span.textContent = (i === 0 ? '👑 ' : '') + p.name;
    list.appendChild(span);
  });
}

// ===================== JOIN =====================
function showJoin() {
  myKind = 'none';
  showScreen('join');
  document.getElementById('join-error').textContent = '';
  document.getElementById('join-room').value = '';
  document.getElementById('join-btn').textContent = '参加する';
  document.getElementById('join-btn').disabled = false;
  const savedName = (function() { try { return localStorage.getItem(LS_NAME) || ''; } catch(e) { return ''; } })();
  if (savedName) document.getElementById('join-name').value = savedName;
}

async function joinRoom() {
  const rid = document.getElementById('join-room').value.trim();
  const name = document.getElementById('join-name').value.trim();
  if (!name) return;
  if (!/^[A-Z0-9]{5}$/.test(rid)) {
    document.getElementById('join-error').textContent = 'ルームコードは半角英数字5文字です。';
    return;
  }
  document.getElementById('join-error').textContent = '';
  document.getElementById('join-btn').textContent = '接続中...';
  document.getElementById('join-btn').disabled = true;
  try {
    await joinAndSubscribe(rid, name);
  } catch(e) {
    let msg = '接続に失敗しました。もう一度お試しください。';
    if (e.message === 'room_not_found') msg = 'ルームが見つかりません。ルームコード（5文字）が正しいか確認してください。';
    else if (e.message === 'name_taken') msg = 'その名前は既に使われています。別の名前でお試しください。';
    else if (e.message === 'host_name_clash') msg = 'その名前はホストが使用中です。別の名前でお試しください。';
    document.getElementById('join-error').textContent = msg;
    document.getElementById('join-btn').textContent = '参加する';
    document.getElementById('join-btn').disabled = false;
    gtag('event', 'join_fail', { reason: e.message || 'unknown' });
  }
}

async function joinAndSubscribe(rid, name) {
  await whenAuthed();
  try { localStorage.setItem(LS_NAME, name); } catch(e) {}
  const { kind, room } = await dbJoinRoom(rid, name);
  roomId = rid;
  if (kind === 'spectator') {
    myKind = 'spectator';
    gtag('event', 'spectator_join');
  } else {
    myKind = 'player';
    gtag('event', kind === 'rejoin' ? 'rejoin_room' : 'join_room', { room_id: rid });
  }
  saveLastRoom(rid, name);
  currentRoom = room;
  subscribeAndDispatch();
}

// ===================== SUBSCRIBE / DISPATCH =====================
function subscribeAndDispatch() {
  unsubFromRoom();
  unsubscribeRoom = subscribeRoom(roomId, (room) => {
    handleRoomUpdate(room);
  });
}

let _enteredPhase = null;  // last phase we transitioned into (for one-shot setup)

function handleRoomUpdate(room) {
  if (room === null) {
    // Room was deleted/disbanded externally
    if (myKind !== 'none' && currentScreenName !== 'title') {
      alert('部屋が解散されました');
    }
    unsubFromRoom();
    roomId = null;
    resetLocalGameState();
    clearLastRoom();
    showScreen('title');
    return;
  }
  currentRoom = room;

  // Recompute my role from DB (host can rejoin and we need to detect it)
  if (room.meta && room.meta.hostUid === myUid()) {
    myKind = 'host';
  } else if (room.players && room.players[myUid()]) {
    if (myKind === 'spectator') {
      // Was spectator, but somehow now a player — unlikely, but handle
      myKind = 'player';
    } else if (myKind === 'none') {
      myKind = 'player';
    }
  }

  // Sync form state if host
  if (isHost() && room.meta) {
    if (room.meta.numPages !== formNumPages) { formNumPages = room.meta.numPages; }
    if (room.meta.timerSec !== formTimerSec) { formTimerSec = room.meta.timerSec; }
    if (room.meta.anonymous !== formAnonymous) { formAnonymous = !!room.meta.anonymous; }
  }

  const targetScreen = (function() {
    if (room.phase === 'lobby') return isHost() ? 'host' : 'lobby';
    return room.phase;
  })();
  const phaseChanged = _enteredPhase !== room.phase;

  if (phaseChanged) {
    _enteredPhase = room.phase;
    _autoSubmittedTimerRound = -2;
    _autoSubmittedTimerTopic = false;
  }

  if (targetScreen === 'host') {
    if (currentScreenName !== 'host') {
      document.getElementById('host-room-code').textContent = roomId;
      renderPageSelect();
      renderTimerSelect();
      showScreen('host');
      wireUpHostScreen();
    }
    renderHostPlayers(room);
  } else if (targetScreen === 'lobby') {
    if (currentScreenName !== 'lobby') {
      if (isSpectator()) {
        document.getElementById('lobby-title').textContent = '👀 観戦中';
        document.getElementById('lobby-subtitle').textContent = 'プレイヤーがタイトルを決めています...';
      } else {
        document.getElementById('lobby-title').textContent = '参加しました！';
        document.getElementById('lobby-subtitle').textContent = 'ホストがゲームを開始するのを待っています...';
      }
      showScreen('lobby');
    }
    renderLobbyPlayers(room);
  } else if (targetScreen === 'topic') {
    enterOrUpdateTopic(room, phaseChanged);
  } else if (targetScreen === 'writing') {
    enterOrUpdateWriting(room, phaseChanged);
  } else if (targetScreen === 'results') {
    enterOrUpdateResults(room, phaseChanged);
  }

  updateTimerState(room);
}

// ===================== HOST: START GAME =====================
async function startGame() {
  if (!isHost() || !currentRoom) return;
  if (numPlayers() < 2) return;
  gtag('event', 'game_start', {
    player_count: numPlayers(),
    page_count: currentRoom.meta.numPages,
  });
  try {
    await dbStartGame(roomId);
  } catch(e) {
    alert('ゲーム開始に失敗しました: ' + (e.message || e));
  }
}

// ===================== TOPIC PHASE =====================
function randomTopic() {
  const topic = generateRandomTopic();
  document.getElementById('topic-input').value = topic;
  saveDraftValue(SS_TOPIC_DRAFT, topic);
}

function saveTopicDraft() {
  const v = document.getElementById('topic-input').value;
  saveDraftValue(SS_TOPIC_DRAFT, v);
}

function enterOrUpdateTopic(room, phaseChanged) {
  if (isSpectator()) {
    // Spectator sees a waiting message during topic phase
    if (currentScreenName !== 'lobby') {
      document.getElementById('lobby-title').textContent = '👀 観戦中';
      document.getElementById('lobby-subtitle').textContent = 'プレイヤーがタイトルを決めています...';
      renderLobbyPlayers(room);
      showScreen('lobby');
    }
    return;
  }

  const topics = room.topics || {};
  const alreadySubmitted = !!(topics[myUid()] && topics[myUid()] !== '');
  myTopicSubmitted = alreadySubmitted;

  if (phaseChanged || currentScreenName !== 'topic') {
    // First time entering this screen
    document.getElementById('topic-input').value = alreadySubmitted
      ? topics[myUid()]
      : loadDraftValue(SS_TOPIC_DRAFT);
    document.getElementById('topic-submit-btn').textContent = alreadySubmitted ? '変更' : '決定';
    document.getElementById('topic-submitted-msg').classList.toggle('hidden', !alreadySubmitted);
    if (alreadySubmitted) setTopicSubmitStatus('confirmed');
    document.getElementById('host-panel-topic').classList.toggle('hidden', !isHost());
    showScreen('topic');
  }
  updateTopicProgress(room);
  if (isHost()) renderHostTopicStatusInline(room);
}

async function submitTopic() {
  const topic = document.getElementById('topic-input').value.trim();
  if (!topic) return;
  gtag('event', 'submit_topic');
  myTopicSubmitted = true;
  document.getElementById('topic-submitted-msg').classList.remove('hidden');
  document.getElementById('topic-submit-btn').textContent = '変更';
  setTopicSubmitStatus('sending');
  saveDraftValue(SS_TOPIC_DRAFT, topic);
  try {
    await dbSubmitTopic(roomId, topic);
    setTopicSubmitStatus('confirmed');
  } catch(e) {
    setTopicSubmitStatus('error');
    console.error('submitTopic failed', e);
  }
}

function setTopicSubmitStatus(status) {
  const el = document.getElementById('topic-submitted-text');
  if (status === 'sending') {
    el.style.color = '#f0c040';
    el.textContent = '⏳ 送信中...';
  } else if (status === 'error') {
    el.style.color = '#e94560';
    el.textContent = '✗ 送信失敗。もう一度お試しください。';
  } else {
    el.style.color = '#4ecdc4';
    el.textContent = '✓ 決定済み（他のプレイヤーが決めるまで変更できます）';
  }
}

function updateTopicProgress(room) {
  const total = numPlayers();
  const topics = room.topics || {};
  const done = Object.values(topics).filter(t => t && t !== '').length;
  document.getElementById('topic-done').textContent = done;
  document.getElementById('topic-total').textContent = total;
  document.getElementById('topic-progress').style.width = total > 0 ? (done / total * 100) + '%' : '0%';
}

function renderHostTopicStatusInline(room) {
  const el = document.getElementById('host-topic-status-inline');
  if (!el) return;
  const ps = playersSorted(room);
  const topics = room.topics || {};
  let html = '<p style="font-size:12px;color:#8899aa;margin-bottom:6px;font-family:\'Noto Sans JP\',sans-serif;">提出状況：</p><div style="display:flex;flex-wrap:wrap;gap:6px;">';
  ps.forEach(p => {
    const done = !!(topics[p.uid] && topics[p.uid] !== '');
    const color = done ? '#4ecdc4' : '#555';
    const icon = done ? '✓' : '…';
    html += '<span style="font-size:12px;padding:3px 8px;border-radius:12px;background:' + (done ? 'rgba(78,205,196,0.15)' : 'rgba(255,255,255,0.05)') + ';color:' + color + ';font-family:\'Noto Sans JP\',sans-serif;">' + icon + ' ' + escHtml(p.name) + '</span>';
  });
  html += '</div>';
  el.innerHTML = html;
}

// ===================== WRITING PHASE =====================
function enterOrUpdateWriting(room, phaseChanged) {
  if (isSpectator()) {
    // Spectator goes straight to a live results view
    enterOrUpdateResults(room, phaseChanged);
    return;
  }

  const round = room.round || 0;
  const np = numPlayers();

  // Determine which story this player writes this round
  if (room.shifts && np > 0) {
    const myOrd = myOrder();
    let si = -1;
    for (let s = 0; s < np; s++) {
      if (getWriterForStoryAtRound(s, round, np, room.shifts) === myOrd) { si = s; break; }
    }
    myStoryIndex = si;
  }

  // Detect if I've submitted this round
  const roundDone = room.roundDone || {};
  const iSubmittedThisRound = !!roundDone[myUid()];

  // Only re-render the writing UI when ROUND actually changes (or we're just
  // arriving at the screen). Re-rendering on every room update would clobber
  // the textarea each time someone else submits — even setting value to the
  // same string moves the cursor and breaks IME composition.
  const enteringRound = phaseChanged
    || currentScreenName !== 'writing'
    || _lastRenderedRound !== round;
  if (enteringRound) {
    _lastRenderedRound = round;
    mySubmittedRound = iSubmittedThisRound ? round : -1;
    if (myStoryIndex >= 0 && room.stories && room.stories[myStoryIndex]) {
      const story = room.stories[myStoryIndex];
      document.getElementById('write-title').textContent = '📖 ' + story.title;
      document.getElementById('write-round').textContent = (round + 1) + ' / ' + room.meta.numPages;

      // Show previous part if any (last part from a previous round)
      const parts = story.parts || [];
      let prevText = null;
      if (round > 0) {
        for (let i = parts.length - 1; i >= 0; i--) {
          if (parts[i] && parts[i].round < round) { prevText = parts[i].text; break; }
        }
      }
      if (prevText) {
        document.getElementById('write-prev').classList.remove('hidden');
        document.getElementById('write-prev-text').textContent = prevText;
      } else {
        document.getElementById('write-prev').classList.add('hidden');
      }
    }
    // Restore my submitted text if any, else from same-round draft
    if (iSubmittedThisRound && room.stories && room.stories[myStoryIndex]) {
      const myPart = (room.stories[myStoryIndex].parts || []).find(p => p && p.authorUid === myUid() && p.round === round);
      document.getElementById('write-input').value = myPart ? myPart.text : loadPartDraft(round, myStoryIndex);
      document.getElementById('write-submitted-msg').classList.remove('hidden');
      document.getElementById('write-submit-btn').textContent = '再提出';
      setSubmitStatus('confirmed');
    } else {
      document.getElementById('write-input').value = loadPartDraft(round, myStoryIndex);
      document.getElementById('write-submitted-msg').classList.add('hidden');
      document.getElementById('write-submit-btn').textContent = '送信';
    }
    document.getElementById('host-panel-write').classList.toggle('hidden', !isHost());
    updateCharCount();
    showScreen('writing');
  }
  updateWriteProgress(room);
  if (isHost()) renderHostWriteStatus(room);
}

function updateCharCount() {
  const val = document.getElementById('write-input').value;
  const len = val.length;
  const el = document.getElementById('write-char');
  const btn = document.getElementById('write-submit-btn');
  if (len > CHAR_LIMIT) {
    el.textContent = len + ' / ' + CHAR_LIMIT + '（' + (len - CHAR_LIMIT) + '文字オーバー）';
    el.className = 'char-count char-warn';
    btn.disabled = true;
  } else {
    el.textContent = len + ' / ' + CHAR_LIMIT;
    el.className = 'char-count ' + (len >= CHAR_LIMIT - 10 ? 'char-warn' : 'char-ok');
    btn.disabled = false;
  }
  if (currentRoom) savePartDraft(val, currentRoom.round || 0, myStoryIndex);
}

async function submitPart() {
  const text = document.getElementById('write-input').value.trim();
  if (!text || text.length > CHAR_LIMIT) return;
  if (!currentRoom || myStoryIndex < 0) return;
  gtag('event', 'submit_part', { round: (currentRoom.round || 0) + 1 });
  document.getElementById('write-submitted-msg').classList.remove('hidden');
  document.getElementById('write-submit-btn').textContent = '再提出';
  setSubmitStatus('sending');
  mySubmittedRound = currentRoom.round;
  try {
    await dbSubmitPart(roomId, myStoryIndex, currentRoom.round, text);
    setSubmitStatus('confirmed');
  } catch(e) {
    setSubmitStatus('error');
    console.error('submitPart failed', e);
  }
}

function setSubmitStatus(status) {
  const el = document.getElementById('write-submitted-text');
  if (status === 'sending') {
    el.style.color = '#f0c040';
    el.textContent = '⏳ 送信中...';
  } else if (status === 'error') {
    el.style.color = '#e94560';
    el.textContent = '✗ 送信失敗。もう一度お試しください。';
  } else {
    el.style.color = '#4ecdc4';
    el.textContent = '✓ 送信済み（他のプレイヤーが完了するまで再提出できます）';
  }
}

function updateWriteProgress(room) {
  const total = numPlayers();
  const done = Object.values(room.roundDone || {}).filter(v => v === true).length;
  document.getElementById('write-done').textContent = done;
  document.getElementById('write-total').textContent = total;
  document.getElementById('write-progress').style.width = total > 0 ? (done / total * 100) + '%' : '0%';
}

function renderHostWriteStatus(room) {
  const el = document.getElementById('host-write-status');
  if (!el) return;
  const ps = playersSorted(room);
  const roundDone = room.roundDone || {};
  let html = '<p style="font-size:12px;color:#8899aa;margin-bottom:6px;font-family:\'Noto Sans JP\',sans-serif;">提出状況：</p><div style="display:flex;flex-wrap:wrap;gap:6px;">';
  ps.forEach(p => {
    const done = !!roundDone[p.uid];
    const color = done ? '#4ecdc4' : '#555';
    const icon = done ? '✓' : '…';
    html += '<span style="font-size:12px;padding:3px 8px;border-radius:12px;background:' + (done ? 'rgba(78,205,196,0.15)' : 'rgba(255,255,255,0.05)') + ';color:' + color + ';font-family:\'Noto Sans JP\',sans-serif;">' + icon + ' ' + escHtml(p.name) + '</span>';
  });
  html += '</div>';
  el.innerHTML = html;
}

// ===================== TIMER =====================
let _tickInterval = null;

function startLocalTimerTick() {
  stopLocalTimerTick();
  _tickInterval = setInterval(tickTimer, 200);
  tickTimer();
}

function stopLocalTimerTick() {
  if (_tickInterval) { clearInterval(_tickInterval); _tickInterval = null; }
}

function updateTimerState(room) {
  if (!room || !room.timerEndsAt || room.timerEndsAt <= 0
      || (room.phase !== 'topic' && room.phase !== 'writing')) {
    stopLocalTimerTick();
    ['topic-timer', 'write-timer'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.classList.add('hidden');
    });
    return;
  }
  // Ensure correct timer container is shown
  const prefix = room.phase === 'topic' ? 'topic' : 'write';
  const el = document.getElementById(prefix + '-timer');
  if (el) el.classList.remove('hidden');
  if (!_tickInterval) startLocalTimerTick();
}

function tickTimer() {
  const room = currentRoom;
  if (!room || !room.timerEndsAt || room.timerEndsAt <= 0) {
    stopLocalTimerTick();
    return;
  }
  const phase = room.phase;
  if (phase !== 'topic' && phase !== 'writing') {
    stopLocalTimerTick();
    return;
  }
  const prefix = phase === 'topic' ? 'topic' : 'write';
  const total = room.meta.timerSec * 1000;
  const remaining = Math.max(0, room.timerEndsAt - Date.now());
  const sec = Math.ceil(remaining / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  const textEl = document.getElementById(prefix + '-timer-text');
  const barEl = document.getElementById(prefix + '-timer-bar');
  if (textEl) textEl.textContent = min + ':' + String(s).padStart(2, '0');
  if (barEl) {
    const pct = total > 0 ? (remaining / total) * 100 : 0;
    barEl.style.width = pct + '%';
    barEl.className = 'countdown-fill' + (pct <= 15 ? ' critical' : pct <= 33 ? ' urgent' : '');
    if (textEl) textEl.style.color = pct <= 15 ? '#e94560' : pct <= 33 ? '#f0c040' : '#4ecdc4';
  }
  if (remaining <= 0) onTimerExpired(phase);
}

function onTimerExpired(phase) {
  if (isSpectator()) return;
  if (phase === 'topic') {
    if (_autoSubmittedTimerTopic) return;
    _autoSubmittedTimerTopic = true;
    if (!myTopicSubmitted) {
      const text = (document.getElementById('topic-input').value || '').trim() || '無題';
      document.getElementById('topic-input').value = text;
      myTopicSubmitted = true;
      document.getElementById('topic-submitted-msg').classList.remove('hidden');
      document.getElementById('topic-submit-btn').textContent = '変更';
      setTopicSubmitStatus('sending');
      dbSubmitTopic(roomId, text).then(() => setTopicSubmitStatus('confirmed')).catch(() => setTopicSubmitStatus('error'));
    }
    // Grace period: poke advancement for any absent players
    setTimeout(() => pokeTimerExpiry(roomId, 'topic').catch(() => {}), 3500);
  } else if (phase === 'writing' && currentRoom) {
    const round = currentRoom.round || 0;
    if (_autoSubmittedTimerRound === round) return;
    _autoSubmittedTimerRound = round;
    if (mySubmittedRound !== round && myStoryIndex >= 0) {
      const raw = (document.getElementById('write-input').value || '').trim() || '……';
      const text = raw.slice(0, CHAR_LIMIT);
      mySubmittedRound = round;
      document.getElementById('write-submitted-msg').classList.remove('hidden');
      document.getElementById('write-submit-btn').textContent = '再提出';
      setSubmitStatus('sending');
      dbSubmitPart(roomId, myStoryIndex, round, text).then(() => setSubmitStatus('confirmed')).catch(() => setSubmitStatus('error'));
    }
    setTimeout(() => pokeTimerExpiry(roomId, 'writing').catch(() => {}), 3500);
  }
}

// Foreground recovery: re-evaluate timer when the tab becomes visible
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (currentRoom) tickTimer();
  if (currentScreenName === 'title') checkForUpdate();
});

// ===================== RESULTS =====================
function enterOrUpdateResults(room, phaseChanged) {
  const enteringFromOtherScreen = currentScreenName !== 'results';
  if (enteringFromOtherScreen) {
    currentStoryView = 0;
    renderThemeSelector();
    restoreTheme();
    restoreStoryFont();
    showScreen('results');
  }
  renderResultsTabs(room);
  renderStory(room, currentStoryView);
  if (room.phase === 'results') {
    document.getElementById('results-subtitle').textContent = (room.stories || []).length + ' つの物語が完成しました';
  } else if (isSpectator()) {
    const total = room.meta ? room.meta.numPages : 0;
    document.getElementById('results-subtitle').textContent = '👀 観戦中 — 物語が進行中です（ラウンド ' + ((room.round || 0) + 1) + '/' + total + '）';
  }
}

function renderThemeSelector() {
  const cont = document.getElementById('theme-selector');
  cont.innerHTML = '';
  STORY_THEMES.forEach(t => {
    const btn = document.createElement('button');
    btn.title = t.name;
    btn.style.cssText = 'width:24px;height:24px;border-radius:50%;border:2px solid ' + (t.id === currentTheme.id ? '#f0c040' : 'transparent') + ';cursor:pointer;background:' + t.dot + ';transition:border-color 0.2s;outline:none;padding:0;';
    btn.onmouseover = () => { if (t.id !== currentTheme.id) btn.style.borderColor = 'rgba(240,192,64,0.4)'; };
    btn.onmouseout = () => { if (t.id !== currentTheme.id) btn.style.borderColor = 'transparent'; };
    btn.onclick = () => { applyTheme(t.id); };
    cont.appendChild(btn);
  });
}

function applyTheme(themeId) {
  const t = STORY_THEMES.find(th => th.id === themeId);
  if (!t) return;
  if (currentTheme.id !== t.id) gtag('event', 'change_theme', { theme: themeId });
  currentTheme = t;
  const el = document.getElementById('results-story');
  el.style.background = t.gradient;
  el.style.borderColor = t.border;
  el.style.color = t.text;
  renderThemeSelector();
  if (currentRoom) renderStory(currentRoom, currentStoryView);
  try { localStorage.setItem(LS_THEME, themeId); } catch(e) {}
}

function restoreTheme() {
  try {
    const saved = localStorage.getItem(LS_THEME);
    if (saved && STORY_THEMES.some(t => t.id === saved)) {
      applyTheme(saved);
      return;
    }
  } catch(e) {}
  applyTheme('midnight');
}

function changeStoryFont(fontFamily) {
  gtag('event', 'change_font', { font: fontFamily });
  document.getElementById('results-story').style.fontFamily = fontFamily;
  document.getElementById('story-font-select').style.fontFamily = fontFamily;
  try { localStorage.setItem(LS_FONT, fontFamily); } catch(e) {}
}

function restoreStoryFont() {
  try {
    const saved = localStorage.getItem(LS_FONT);
    if (saved) {
      document.getElementById('results-story').style.fontFamily = saved;
      document.getElementById('story-font-select').value = saved;
      document.getElementById('story-font-select').style.fontFamily = saved;
    }
  } catch(e) {}
}

function renderResultsTabs(room) {
  const cont = document.getElementById('results-tabs');
  cont.innerHTML = '';
  (room.stories || []).forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'story-tab' + (i === currentStoryView ? ' active' : '');
    btn.textContent = s.title;
    btn.onclick = () => {
      currentStoryView = i;
      renderResultsTabs(room);
      renderStory(room, i);
    };
    cont.appendChild(btn);
  });
}

function getPlayerColorByUid(uid) {
  const order = orderOfUid(uid);
  return PLAYER_COLORS[Math.max(0, order) % PLAYER_COLORS.length];
}

function renderStory(room, idx) {
  const story = (room.stories || [])[idx];
  if (!story) {
    document.getElementById('results-story').innerHTML = '';
    return;
  }
  const t = currentTheme;
  const anon = room.meta && room.meta.anonymous;
  let html = '<h3 style="font-size:22px;text-align:center;margin-bottom:24px;color:' + t.title + ';">「' + escHtml(story.title) + '」</h3>';
  (story.parts || []).forEach((part, i) => {
    if (!part) return;
    const authorName = nameOfUid(part.authorUid) || '（不明）';
    const color = anon ? t.meta : getPlayerColorByUid(part.authorUid);
    html += '<div class="part-block" style="border-left:3px solid ' + color + ';">';
    if (anon) {
      html += '<p style="font-size:12px;margin-bottom:4px;color:' + t.meta + ';">ページ ' + (i + 1) + '</p>';
    } else {
      html += '<p style="font-size:12px;margin-bottom:4px;"><span style="color:' + color + ';font-weight:700;">' + escHtml(authorName) + '</span> <span style="color:' + t.meta + ';">— ページ ' + (i + 1) + '</span></p>';
    }
    html += '<p style="font-size:16px;line-height:1.8;white-space:pre-wrap;">' + escHtml(part.text) + '</p>';
    html += '</div>';
  });
  document.getElementById('results-story').innerHTML = html;
}

// ===================== ABORT / PLAY AGAIN =====================
async function confirmAbortGame() {
  if (!isHost()) return;
  if (currentRoom && currentRoom.phase !== 'lobby' && (currentRoom.stories || []).length > 0) {
    if (confirm('ゲームを中断しますか？\n全員の画面が結果表示に切り替わります。')) {
      gtag('event', 'game_abort', { phase: currentRoom.phase });
      // Stay subscribed — we want to follow the transition to the results screen.
      try { await dbAbortGame(roomId); } catch(e) {}
    }
  } else {
    if (confirm('ゲームを中断しますか？\n全員がタイトル画面に戻ります。')) {
      gtag('event', 'game_abort', { phase: currentRoom ? currentRoom.phase : 'unknown', action: 'back_to_title' });
      // Unsub before disbanding so we don't trigger the "解散" alert on ourselves.
      const rid = roomId;
      _localCleanup();
      if (rid) { try { await disbandRoom(rid); } catch(e) {} }
      showScreen('title');
    }
  }
}

function playAgain() {
  const name = (myPlayer() && myPlayer().name) || '';
  if (name) { try { localStorage.setItem(LS_NAME, name); } catch(e) {} }
  // Intentionally don't disband — other clients (especially guests) may want
  // to keep reading the finished story. The room will linger in DB until a
  // future cleanup pass; that's the trade-off for letting people stay.
  _localCleanup();
  showScreen('title');
}

// ===================== COPY / SCREENSHOT =====================
function toggleCopyMenu() {
  const menu = document.getElementById('copy-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function hideCopyMenu() {
  document.getElementById('copy-menu').style.display = 'none';
}

document.addEventListener('click', (e) => {
  const menu = document.getElementById('copy-menu');
  if (menu && menu.style.display === 'block' && !e.target.closest('#copy-menu') && !e.target.closest('[onclick*="toggleCopyMenu"]')) {
    menu.style.display = 'none';
  }
});

function copyStoryAsText(mode) {
  gtag('event', 'copy_story', { mode });
  if (!currentRoom) return;
  const story = (currentRoom.stories || [])[currentStoryView];
  if (!story) return;
  let text = '';
  const anon = currentRoom.meta && currentRoom.meta.anonymous;
  if (mode === 'simple') {
    text += '「' + story.title + '」\n\n';
    (story.parts || []).forEach((part) => { if (part) text += part.text + '\n\n'; });
    text = text.trimEnd();
  } else {
    text += '📖 じゃれ本（餅天）\n';
    text += '━━━━━━━━━━━━━━━━\n';
    text += '「' + story.title + '」\n';
    text += '━━━━━━━━━━━━━━━━\n\n';
    (story.parts || []).forEach((part, i) => {
      if (!part) return;
      if (anon) {
        text += '【ページ ' + (i + 1) + '】\n';
      } else {
        text += '【ページ ' + (i + 1) + '】' + (nameOfUid(part.authorUid) || '（不明）') + '\n';
      }
      text += part.text + '\n\n';
    });
    text += '━━━━━━━━━━━━━━━━';
  }
  navigator.clipboard.writeText(text).then(() => {
    showCopyFeedback('テキストをコピーしました！');
  }).catch(() => {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    showCopyFeedback('テキストをコピーしました！');
  });
}

function saveStoryAsImage() {
  gtag('event', 'screenshot_story');
  const el = document.getElementById('results-story');
  showCopyFeedback('画像を生成中...');
  html2canvas(el, {
    backgroundColor: currentTheme.bg,
    scale: 2,
    useCORS: true,
  }).then(canvas => {
    const link = document.createElement('a');
    const story = currentRoom && (currentRoom.stories || [])[currentStoryView];
    const title = story ? story.title.slice(0, 10) : 'story';
    link.download = 'じゃれ本（餅天）_' + title + '.png';
    link.href = canvas.toDataURL('image/png');
    link.click();
    showCopyFeedback('画像を保存しました！');
  }).catch(() => {
    showCopyFeedback('画像の生成に失敗しました');
  });
}

function showCopyFeedback(msg) {
  const el = document.getElementById('copy-feedback');
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.style.opacity = '0'; }, 2500);
}

// ===================== ROOM CODE INPUT (iOS 12-key keyboard safe) =====================
(function() {
  const el = document.getElementById('join-room');
  let composing = false;
  el.addEventListener('compositionstart', () => { composing = true; });
  el.addEventListener('compositionend', () => {
    composing = false;
    el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
  el.addEventListener('input', () => {
    if (composing) return;
    el.value = el.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
  });
})();

// ===================== AUTO-RESTORE ON LOAD =====================
window.addEventListener('load', async () => {
  await whenAuthed();
  const last = loadLastRoom();
  if (last && last.roomId && last.name) {
    try {
      await joinAndSubscribe(last.roomId, last.name);
      return;
    } catch(e) {
      // Room is gone or join failed — fall through to title
      clearLastRoom();
    }
  }
  updateRejoinButton();
});

// ===================== AUTO-UPDATE CHECK =====================
let _lastUpdateCheck = Date.now();
const UPDATE_CHECK_INTERVAL = 60 * 1000;

function checkForUpdate() {
  if (currentScreenName !== 'title') return;
  if (myKind !== 'none') return;
  if (Date.now() - _lastUpdateCheck < UPDATE_CHECK_INTERVAL) return;
  _lastUpdateCheck = Date.now();
  fetch(location.pathname + '?_v=' + Date.now(), { cache: 'no-store' })
    .then(r => r.ok ? r.text() : '')
    .then(html => {
      if (!html) return;
      const m = html.match(/APP_VERSION\s*=\s*'([^']+)'/);
      if (m && m[1] && m[1] !== window.APP_VERSION) {
        dbg('Update available: ' + window.APP_VERSION + ' -> ' + m[1]);
        location.reload();
      }
    })
    .catch(() => {});
}

// ===================== DEBUG OVERLAY =====================
initDebug(document.getElementById('debug-log'));
let _tapCount = 0, _tapTimer = null;
document.getElementById('version-label').textContent = window.APP_VERSION;
document.getElementById('version-label').addEventListener('click', () => {
  _tapCount++;
  if (_tapTimer) clearTimeout(_tapTimer);
  _tapTimer = setTimeout(() => { _tapCount = 0; }, 600);
  if (_tapCount >= 3) {
    _tapCount = 0;
    const newState = !isDebugOn();
    setDebugEnabled(newState);
    if (newState) dbg('Debug ON | kind=' + myKind + ' phase=' + (currentRoom && currentRoom.phase) + ' uid=' + myUid());
  }
});

// ===================== EXPOSE TO INLINE onclick HANDLERS =====================
Object.assign(window, {
  showHostSetup, showJoin, rejoinLastRoom, backToTitle, leaveLobby,
  copyRoomCode, copyRoomCodeBadge,
  startGame, randomTopic, saveTopicDraft, submitTopic,
  confirmAbortGame, updateCharCount, submitPart,
  joinRoom,
  changeStoryFont, toggleCopyMenu, hideCopyMenu, copyStoryAsText, saveStoryAsImage,
  playAgain,
});
