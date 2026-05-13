import { generateRandomTopic } from './topics-gen.js';
import { generateRoomId, generateToken, generateRotation, getWriterForStoryAtRound } from './game-helpers.js';
import { STORY_THEMES, PLAYER_COLORS, TIMER_OPTIONS } from './themes.js';
import { escHtml, dbg, initDebug, setDebugEnabled, isDebugOn } from './utils.js';

// ===================== STATE =====================
let peer = null;
let connections = [];       // host: connections to guests
let spectators = [];        // host: connections to spectators
let hostConn = null;        // guest: connection to host
let isHost = false;
let myIndex = 0;
let roomId = "";
let numPages = 4;
let timerSec = 0; // default: no limit
let players = [];
let topicsCollected = [];
let gameState = null;
let roundDone = new Set();
let myStoryIndex = -1;
let mySubmitted = false;
let myLastSubmittedText = "";
let gamePhase = "idle"; // idle, lobby, topic, writing, results
let guestConnGen = 0;  // generation counter for ignoring stale events
let reconnectTimer = null;
let playerTokens = [];
let guestConnected = false; // host: token per player for identity verification

// ===================== HOST PERSISTENCE =====================
const LS_HOST = 'watashibunko_host';

function saveHostState() {
  if (!isHost) return;
  try {
    localStorage.setItem(LS_HOST, JSON.stringify({
      roomId, numPages, timerSec, players, topicsCollected: topicsCollected || [],
      gameState: gameState ? JSON.parse(JSON.stringify(gameState)) : null,
      roundDoneList: [...roundDone], gamePhase, playerTokens,
      timerDeadline: countdownDeadline || 0,
      timerTotalMs: countdownTotal || 0,
      timerPhase: activeTimerPhase || '',
    }));
  } catch(e) {}
}

function loadHostState() {
  try { const s = localStorage.getItem(LS_HOST); return s ? JSON.parse(s) : null; } catch(e) { return null; }
}

function clearHostState() {
  try { localStorage.removeItem(LS_HOST); } catch(e) {}
}

// ===================== GUEST PERSISTENCE =====================
const LS_GUEST = 'watashibunko_guest';

let isSpectator = false;
let spectatorName = '';

function saveGuestState() {
  if (isHost) return;
  try {
    const name = isSpectator ? spectatorName : (players[myIndex] || '');
    localStorage.setItem(LS_GUEST, JSON.stringify({
      roomId, myIndex, playerName: name,
      isSpectator,
    }));
  } catch(e) {}
}

function loadGuestState() {
  try { const s = localStorage.getItem(LS_GUEST); return s ? JSON.parse(s) : null; } catch(e) { return null; }
}

function clearGuestState() {
  try { localStorage.removeItem(LS_GUEST); } catch(e) {}
}

// Persists finished game results so reload shows results screen
const LS_FINISHED = 'watashibunko_finished';

function saveFinishedGame() {
  try {
    localStorage.setItem(LS_FINISHED, JSON.stringify({
      gameState: JSON.parse(JSON.stringify(gameState)),
    }));
  } catch(e) {}
}

function loadFinishedGame() {
  try { const s = localStorage.getItem(LS_FINISHED); return s ? JSON.parse(s) : null; } catch(e) { return null; }
}

function clearFinishedGame() {
  try { localStorage.removeItem(LS_FINISHED); } catch(e) {}
}

// ===================== COPY ROOM CODE =====================
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

// ===================== ICE SERVERS (TURN) =====================
const PEER_CONFIG = {
  debug: 0,
  config: {
    iceServers: [
      { urls: "stun:stun.relay.metered.ca:80" },
      { urls: "turn:global.relay.metered.ca:80", username: "d5a3f129611357ad1cec1f95", credential: "+RbXfCTO9vtMAhH/" },
      { urls: "turn:global.relay.metered.ca:80?transport=tcp", username: "d5a3f129611357ad1cec1f95", credential: "+RbXfCTO9vtMAhH/" },
      { urls: "turn:global.relay.metered.ca:443", username: "d5a3f129611357ad1cec1f95", credential: "+RbXfCTO9vtMAhH/" },
      { urls: "turns:global.relay.metered.ca:443?transport=tcp", username: "d5a3f129611357ad1cec1f95", credential: "+RbXfCTO9vtMAhH/" },
    ]
  }
};

// ===================== SCREEN MANAGEMENT =====================
const screens = ['title','host','join','lobby','topic','writing','results'];
let currentScreenName = 'title';
function showScreen(name) {
  currentScreenName = name;
  screens.forEach(s => document.getElementById('screen-' + s).classList.toggle('hidden', s !== name));
  updateRoomCodeBadge();
  if (name === 'title') { updateRejoinButton(); checkForUpdate(); }
}

function backToTitle() {
  // If host is in lobby, notify guests to disband
  if (isHost && gamePhase === 'lobby') {
    broadcast({ type: 'hostDisbanded' });
  }
  if (peer) { peer.destroy(); peer = null; }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  guestConnGen++;
  connections = []; hostConn = null;
  isSpectator = false;
  playerTokens = [];
  clearHostState();
  clearGuestState();
  clearFinishedGame();
  try { sessionStorage.removeItem('watashibunko_token'); sessionStorage.removeItem('watashibunko_topic'); sessionStorage.removeItem('watashibunko_topic_draft'); } catch(e) {}
  clearDraft();
  stopHeartbeat();
  hideDisconnectOverlay();
  showScreen('title');
}

function leaveLobby() {
  guestConnGen++;
  clearGuestState();
  try { sessionStorage.removeItem('watashibunko_token'); sessionStorage.removeItem('watashibunko_topic'); sessionStorage.removeItem('watashibunko_topic_draft'); } catch(e) {}
  if (hostConn && hostConn.open) {
    try { hostConn.send({ type: 'leave', playerIndex: myIndex }); } catch(e) {}
  }
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (peer) { peer.destroy(); peer = null; }
  hostConn = null;
  showScreen('title');
}

let dismissCountdownTimer = null;

function showDisconnectOverlay() {
  document.getElementById('disconnect-overlay').style.display = 'flex';
  // Start countdown for dismiss button
  const btn = document.getElementById('dismiss-btn');
  btn.disabled = true;
  let remaining = 6;
  btn.textContent = '諦めてタイトルに戻る（' + remaining + '）';
  if (dismissCountdownTimer) clearInterval(dismissCountdownTimer);
  dismissCountdownTimer = setInterval(() => {
    remaining--;
    if (remaining <= 0) {
      clearInterval(dismissCountdownTimer);
      dismissCountdownTimer = null;
      btn.textContent = '諦めてタイトルに戻る';
      btn.disabled = false;
    } else {
      btn.textContent = '諦めてタイトルに戻る（' + remaining + '）';
    }
  }, 1000);
}

function hideDisconnectOverlay() {
  document.getElementById('disconnect-overlay').style.display = 'none';
  if (dismissCountdownTimer) { clearInterval(dismissCountdownTimer); dismissCountdownTimer = null; }
}

function dismissDisconnect() {
  hideDisconnectOverlay();
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  resetReconnectAttempts();
  guestConnGen++;
  isSpectator = false;
  stopHeartbeat();
  if (peer) { peer.destroy(); peer = null; }
  connections = []; hostConn = null;
  clearGuestState();
  showScreen('title');
}

// ===================== HEARTBEAT =====================
let heartbeatInterval = null;
let heartbeatTimeout = null;

function startHostHeartbeat() {
  stopHeartbeat();
  heartbeatInterval = setInterval(() => {
    if (!isHost) return;
    broadcast({ type: 'ping' });
    // Check if any guest connections are dead and try reverse reconnect
    if (gamePhase !== 'idle' && gamePhase !== 'lobby' && peer && peer.open) {
      const now = Date.now();
      let hasDead = false;
      connections.forEach(c => {
        if (c._guestPeerId && (now - (c._lastActivity || 0)) > 15000) hasDead = true;
      });
      if (hasDead) reconnectToGuests();
    }
  }, 5000);
}

function startGuestHeartbeat(rid, name) {
  stopHeartbeat();
  resetHeartbeatTimeout(rid, name);
}

function resetHeartbeatTimeout(rid, name) {
  if (heartbeatTimeout) clearTimeout(heartbeatTimeout);
  heartbeatTimeout = setTimeout(() => {
    if (currentScreenName === 'title' || currentScreenName === 'join') return;
    if (gamePhase === 'idle') { stopHeartbeat(); return; }
    dbg('GUEST heartbeat timeout, reconnecting silently');
    gtag('event', 'connection_lost', { phase: gamePhase });
    if (hostConn) { try { hostConn.close(); } catch(e) {} }
    scheduleGuestReconnect(rid, name);
  }, 15000);
}

function stopHeartbeat() {
  if (heartbeatInterval) { clearInterval(heartbeatInterval); heartbeatInterval = null; }
  if (heartbeatTimeout) { clearTimeout(heartbeatTimeout); heartbeatTimeout = null; }
}

// Detect host returning from background and proactively check connections
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (!isHost || gamePhase === 'idle' || gamePhase === 'lobby') return;
  // Host just came back to foreground — check peer health
  dbg('HOST visibilitychange: returned to foreground');
  setTimeout(() => {
    if (!peer || peer.destroyed) {
      // Peer is dead, recreate
      dbg('HOST peer dead, recreating');
      initHostPeer(roomId);
      return;
    }
    if (peer.disconnected && !peer.open) {
      dbg('HOST peer disconnected, recreating');
      initHostPeer(roomId);
      return;
    }
    const now = Date.now();
    dbg('HOST vischeck: peer=' + (peer ? (peer.destroyed ? 'destroyed' : (peer.disconnected ? 'disconnected' : (peer.open ? 'open' : 'other'))) : 'null') + ' conns=' + connections.length);
    const deadConns = connections.filter(c => (now - (c._lastActivity || 0)) > 15000);
    const aliveConns = connections.filter(c => (now - (c._lastActivity || 0)) <= 15000);
    dbg('HOST alive=' + aliveConns.length + ' dead=' + deadConns.length + ' withPeerId=' + connections.filter(c => c._guestPeerId).length);
    // Send a test ping first to flush dead connections
    try { broadcast({ type: 'ping' }); } catch(e) {}
    // Wait a moment for close events to fire, then reconnect
    setTimeout(() => {
      reconnectToGuests();
    }, 2000);
  }, 500);
});

function initHostPeer(rid) {
  if (peer && !peer.destroyed) peer.destroy();
  peer = new Peer('watashibunko-' + rid, PEER_CONFIG);
  peer.on('open', () => {
    dbg('HOST peer.open rid=' + rid);
    // After reconnect, actively reach out to guests with dead connections
    if (gamePhase !== 'idle' && gamePhase !== 'lobby') {
      setTimeout(() => reconnectToGuests(), 1000);
    }
  });
  peer.on('connection', (conn) => {
    conn.on('open', () => {
      conn._lastActivity = Date.now();
      conn.on('data', (data) => handleHostMessage(conn, data));
      conn.on('close', () => {
        dbg('HOST conn.close: ' + conn._playerName);
        // In lobby phase, auto-remove disconnected guest
        if (gamePhase === 'lobby' && conn._playerIndex >= 1) {
          const idx = conn._playerIndex;
          const stillConnected = connections.some(c => c._playerIndex === idx && c !== conn && c.open);
          if (!stillConnected) {
            const name = conn._playerName;
            const pIdx = players.indexOf(name);
            if (pIdx >= 1) {
              players.splice(pIdx, 1);
              playerTokens.splice(pIdx, 1);
              connections = connections.filter(c => c !== conn);
              connections.forEach(c => {
                const newIdx = players.indexOf(c._playerName);
                if (newIdx >= 0) {
                  c._playerIndex = newIdx;
                  c.send({ type: 'joined', playerIndex: newIdx, players: [...players] });
                }
              });
              renderHostPlayers();
              saveHostState();
              dbg('HOST auto-removed from lobby: ' + name);
            }
          }
        }
      });
    });
  });
  peer.on('disconnected', () => {
    if (!peer || peer.destroyed) return;
    try { peer.reconnect(); } catch(e) {}
    setTimeout(() => {
      if (peer && !peer.destroyed && peer.disconnected && !peer.open) {
        dbg('HOST reconnect failed, recreating');
        initHostPeer(rid);
      }
    }, 5000);
  });
  peer.on('error', (e) => {
    dbg('HOST peer.error: ' + e.type);
    if (e.type === 'unavailable-id') {
      setTimeout(() => initHostPeer(rid), 3000);
    } else if (e.type === 'network' || e.type === 'server-error' || e.type === 'socket-error') {
      setTimeout(() => {
        if (peer && peer.disconnected) initHostPeer(rid);
      }, 5000);
    }
  });
}

function reconnectToGuests() {
  if (!isHost || !peer || peer.destroyed || !peer.open) {
    dbg('HOST reconnectToGuests: skip (host=' + isHost + ' peer=' + (peer ? (peer.open ? 'open' : 'not-open') : 'null') + ')');
    return;
  }
  const now = Date.now();
  const DEAD_THRESHOLD = 15000; // 15 seconds without activity = dead
  let tried = 0;
  connections.forEach(oldConn => {
    const guestPeerId = oldConn._guestPeerId;
    const pIdx = oldConn._playerIndex;
    const pName = oldConn._playerName;
    if (!guestPeerId) return;
    const lastAct = oldConn._lastActivity || 0;
    const age = now - lastAct;
    if (age < DEAD_THRESHOLD) {
      dbg('HOST skip ' + pName + ' (active ' + Math.round(age/1000) + 's ago)');
      return; // still alive
    }
    tried++;
    dbg('HOST reconnectToGuest: ' + pName + ' pid=' + guestPeerId + ' lastAct=' + Math.round(age/1000) + 's ago');
    try {
      const newConn = peer.connect(guestPeerId);
      newConn._playerIndex = pIdx;
      newConn._playerName = pName;
      newConn._guestPeerId = guestPeerId;
      newConn.on('open', () => {
        // Replace old connection
        connections = connections.filter(c => c._playerIndex !== pIdx);
        connections.push(newConn);
        newConn.on('data', (data) => handleHostMessage(newConn, data));
        newConn.on('close', () => { dbg('HOST reverse conn.close: ' + pName); });
        // Send rejoinState so guest can recover
        const revToken = playerTokens[pIdx] || generateToken();
        playerTokens[pIdx] = revToken;
        newConn.send({
          type: 'rejoinState',
          playerIndex: pIdx,
          players: [...players],
          gamePhase,
          gameState: gameState ? JSON.parse(JSON.stringify(gameState)) : null,
          roundDoneList: [...roundDone],
          playerAlreadySubmitted: roundDone.has(pIdx),
          topicAlreadySubmitted: topicsCollected[pIdx] != null && topicsCollected[pIdx] !== '',
          topicsDone: topicsCollected.filter(t => t != null && t !== '').length,
          topicsTotal: topicsCollected.length,
          isReverseConnection: true,
          token: revToken,
          timerRemainingSec: activeTimerPhase && countdownDeadline > Date.now() ? Math.ceil((countdownDeadline - Date.now()) / 1000) : 0,
          timerTotalSec: activeTimerPhase ? Math.ceil(countdownTotal / 1000) : 0,
        });
      });
      newConn.on('error', () => {
        dbg('HOST reverse connect FAILED: ' + pName);
      });
    } catch(e) {}
  });
}

// ===================== HOST SETUP =====================
function showHostSetup() {
  isHost = true;
  myIndex = 0;
  roomId = generateRoomId();
  gamePhase = 'lobby';
  gtag('event', 'create_room', { room_id: roomId });
  document.getElementById('host-room-code').textContent = roomId;
  // Prefill saved name
  const savedName = (function() { try { return localStorage.getItem('watashibunko_name') || ''; } catch(e) { return ''; } })();
  if (savedName) document.getElementById('host-name').value = savedName;
  renderPageSelect();
  renderTimerSelect();
  showScreen('host');

  initHostPeer(roomId);
  // Set initial player immediately (not on peer open to avoid reset on reconnect)
  const name = document.getElementById('host-name').value.trim() || 'ホスト';
  players = [name];
  renderHostPlayers();
  saveHostState();

  document.getElementById('host-name').addEventListener('input', () => {
    const name = document.getElementById('host-name').value.trim() || 'ホスト';
    players[0] = name;
    renderHostPlayers();
    saveHostState();
  });
}

function renderPageSelect() {
  const cont = document.getElementById('page-select');
  cont.innerHTML = '';
  [3,4,5,6,8,10,12,16].forEach(n => {
    const btn = document.createElement('button');
    btn.className = 'page-select-btn' + (n === numPages ? ' active' : '');
    btn.textContent = n;
    btn.onclick = () => { numPages = n; renderPageSelect(); };
    cont.appendChild(btn);
  });
}

function renderTimerSelect() {
  const cont = document.getElementById('timer-select');
  cont.innerHTML = '';
  TIMER_OPTIONS.forEach(opt => {
    const btn = document.createElement('button');
    btn.className = 'timer-option' + (opt.sec === timerSec ? ' active' : '');
    btn.innerHTML = '<span class="timer-label">' + opt.label + '</span><span class="timer-desc"><strong>' + opt.name + '</strong> ' + opt.desc + '</span>';
    btn.onclick = () => { timerSec = opt.sec; renderTimerSelect(); };
    cont.appendChild(btn);
  });
}

function renderHostPlayers() {
  const list = document.getElementById('host-player-list');
  list.innerHTML = '';
  players.forEach((p, i) => {
    const span = document.createElement('span');
    span.className = 'badge ' + (i === 0 ? 'badge-gold' : 'badge-green');
    span.textContent = (i === 0 ? '👑 ' : '') + p;
    list.appendChild(span);
  });
  document.getElementById('host-player-count').textContent = players.length;
  const canStart = players.length >= 2 && (document.getElementById('host-name').value.trim() !== '');
  document.getElementById('start-btn').disabled = !canStart;
  document.getElementById('start-btn').textContent = 'ゲーム開始（' + players.length + '人）';
  document.getElementById('start-hint').classList.toggle('hidden', players.length >= 2);
}

function renderLobbyPlayers() {
  const list = document.getElementById('lobby-player-list');
  list.innerHTML = '';
  players.forEach((p, i) => {
    const span = document.createElement('span');
    span.className = 'badge ' + (i === 0 ? 'badge-gold' : 'badge-green');
    span.textContent = (i === 0 ? '👑 ' : '') + p;
    list.appendChild(span);
  });
}

// ===================== HOST MESSAGE HANDLER =====================
function handleHostMessage(conn, data) {
  conn._lastActivity = Date.now();
  if (data.type === 'pong') return; // heartbeat response, just update activity
  if (data.type === 'join') {
    // Check if this is a rejoin (same name as existing player) during game
    const existingIdx = players.indexOf(data.name);
    if (existingIdx >= 1 && gamePhase !== 'lobby') {
      const hostHasToken = !!playerTokens[existingIdx];
      const tokenMatch = data.token && hostHasToken && data.token === playerTokens[existingIdx];
      if (tokenMatch || gamePhase === 'results' || !hostHasToken) {
        // Allow: same person (token match), game over, or host lost tokens (host reload)
      } else {
        // Token mismatch — always reject (regardless of connection state)
        conn.send({ type: 'joinError', message: 'その名前は既に使われています。別の名前でお試しください。' });
        return;
      }
      // Reuse existing token if matched; adopt guest's token if host had none; new token otherwise
      const newToken = tokenMatch ? playerTokens[existingIdx]
        : (!hostHasToken && data.token) ? data.token
        : generateToken();
      playerTokens[existingIdx] = newToken;
      conn._playerIndex = existingIdx;
      conn._playerName = data.name;
      conn._guestPeerId = data.guestPeerId || null;
      connections = connections.filter(c => c._playerIndex !== existingIdx);
      connections.push(conn);
      conn.send({
        type: 'rejoinState',
        playerIndex: existingIdx,
        players: [...players],
        gamePhase,
        gameState: gameState ? JSON.parse(JSON.stringify(gameState)) : null,
        roundDoneList: [...roundDone],
        playerAlreadySubmitted: roundDone.has(existingIdx),
        topicAlreadySubmitted: topicsCollected[existingIdx] != null && topicsCollected[existingIdx] !== '',
        topicsDone: topicsCollected.filter(t => t != null && t !== '').length,
        topicsTotal: topicsCollected.length,
        token: newToken,
        timerRemainingSec: activeTimerPhase && countdownDeadline > Date.now() ? Math.ceil((countdownDeadline - Date.now()) / 1000) : 0,
        timerTotalSec: activeTimerPhase ? Math.ceil(countdownTotal / 1000) : 0,
      });
      return;
    }

    // Game already in progress and this is a new name — spectator mode
    if (gamePhase !== 'lobby' && gamePhase !== 'idle') {
      // Block if same name as host
      if (data.name === players[0]) {
        conn.send({ type: 'joinError', message: 'その名前はホストが使用中です。別の名前でお試しください。' });
        return;
      }
      conn._playerName = data.name;
      conn._isSpectator = true;
      spectators.push(conn);
      conn.on('close', () => { spectators = spectators.filter(s => s !== conn); });
      conn.send({
        type: 'spectatorState',
        gameState: gameState ? JSON.parse(JSON.stringify(gameState)) : null,
        gamePhase,
        players: [...players],
      });
      return;
    }

    // Normal new join (lobby phase)
    const lobbyDup = players.indexOf(data.name);
    if (lobbyDup >= 0) {
      if (lobbyDup >= 1 && data.token && data.token === playerTokens[lobbyDup]) {
        // Same person reconnecting (e.g. reload) — token matches
        conn._playerIndex = lobbyDup;
        conn._playerName = data.name;
        conn._guestPeerId = data.guestPeerId || null;
        connections = connections.filter(c => c._playerIndex !== lobbyDup);
        connections.push(conn);
        conn.send({ type: 'joined', playerIndex: lobbyDup, players: [...players], token: playerTokens[lobbyDup] });
      } else {
        // Check if existing connection is dead (orphan) — if so, allow takeover
        const existingConn = connections.find(c => c._playerIndex === lobbyDup);
        const existingAlive = existingConn && existingConn.open;
        if (!existingAlive && lobbyDup >= 1) {
          // Orphan — replace with new player
          const newToken = generateToken();
          playerTokens[lobbyDup] = newToken;
          conn._playerIndex = lobbyDup;
          conn._playerName = data.name;
          conn._guestPeerId = data.guestPeerId || null;
          connections = connections.filter(c => c._playerIndex !== lobbyDup);
          connections.push(conn);
          conn.send({ type: 'joined', playerIndex: lobbyDup, players: [...players], token: newToken });
        } else {
          conn.send({ type: 'joinError', message: 'その名前は既に使われています。別の名前でお試しください。' });
        }
      }
      return;
    }
    // Brand new player
    const token = generateToken();
    players.push(data.name);
    const newIdx = players.length - 1;
    playerTokens[newIdx] = token;
    conn._playerIndex = newIdx;
    conn._playerName = data.name;
    conn._guestPeerId = data.guestPeerId || null;
    connections = connections.filter(c => c._playerIndex !== newIdx);
    connections.push(conn);
    conn.send({ type: 'joined', playerIndex: newIdx, players: [...players], token });
    broadcast({ type: 'playerList', players: [...players] }, conn);
    renderHostPlayers();
    saveHostState();
  } else if (data.type === 'leave') {
    // Guest leaving the lobby — identify by name
    const name = conn._playerName;
    const idx = players.indexOf(name);
    if (idx >= 1 && gamePhase === 'lobby') {
      players.splice(idx, 1);
      connections = connections.filter(c => c !== conn);
      // Reindex remaining connections and notify all guests of new player list and their new index
      connections.forEach(c => {
        const newIdx = players.indexOf(c._playerName);
        if (newIdx >= 0) {
          c._playerIndex = newIdx;
          c.send({ type: 'joined', playerIndex: newIdx, players: [...players] });
        }
      });
      renderHostPlayers();
      saveHostState();
    }
  } else if (data.type === 'topicSubmit') {
    handleTopicFromPlayer(conn._playerIndex, data.topic);
    try { conn.send({ type: 'topicAck' }); } catch(e) {}
  } else if (data.type === 'partSubmit') {
    handlePartFromPlayer(conn._playerIndex, data.storyIndex, data.round, data.text, data.isResubmit);
    try { conn.send({ type: 'partAck' }); } catch(e) {}
  }
}

function broadcast(msg, exclude) {
  connections.forEach(c => { if (c !== exclude && c.open) c.send(msg); });
}

function broadcastToSpectators() {
  const msg = {
    type: 'spectatorUpdate',
    gameState: gameState ? JSON.parse(JSON.stringify(gameState)) : null,
    gamePhase,
  };
  spectators.forEach(c => { if (c.open) c.send(msg); });
}

// ===================== JOIN =====================
const LS_LASTROOM = 'watashibunko_lastroom';

function saveLastRoom(rid, name, token) {
  try {
    const existing = JSON.parse(localStorage.getItem(LS_LASTROOM) || '{}');
    const t = token || existing.token || '';
    localStorage.setItem(LS_LASTROOM, JSON.stringify({ roomId: rid, playerName: name, token: t }));
  } catch(e) {}
}

function loadLastRoom() {
  try { const s = localStorage.getItem(LS_LASTROOM); return s ? JSON.parse(s) : null; } catch(e) { return null; }
}

function getToken() {
  // sessionStorage first (current tab), fallback to localStorage (survives tab close)
  try {
    const st = sessionStorage.getItem('watashibunko_token');
    if (st) return st;
  } catch(e) {}
  const last = loadLastRoom();
  return (last && last.token) || '';
}

function saveToken(token) {
  try { sessionStorage.setItem('watashibunko_token', token); } catch(e) {}
  // Also persist in localStorage
  const last = loadLastRoom();
  if (last && last.roomId) {
    saveLastRoom(last.roomId, last.playerName, token);
  }
}

function updateRejoinButton() {
  const btn = document.getElementById('rejoin-btn');
  const last = loadLastRoom();
  if (last && last.roomId && last.playerName) {
    btn.textContent = last.roomId;
    btn.disabled = false;
    btn.style.display = 'block';
  } else {
    btn.style.display = 'none';
  }
}

let _rejoinOrigText = '';

function rejoinLastRoom() {
  const last = loadLastRoom();
  if (!last || !last.roomId || !last.playerName) return;
  gtag('event', 'rejoin_room', { room_id: last.roomId });
  const btn = document.getElementById('rejoin-btn');
  _rejoinOrigText = btn.textContent;
  btn.textContent = '接続中...';
  btn.disabled = true;
  roomId = last.roomId;
  // Set a timeout to restore button if connection fails
  const failTimer = setTimeout(() => {
    if (currentScreenName === 'title') {
      btn.textContent = _rejoinOrigText;
      btn.disabled = false;
    }
  }, 12000);
  // Store the fail timer so we can cancel on success
  btn._failTimer = failTimer;
  joinRoom({ roomId: last.roomId, playerName: last.playerName });
}

function showJoin() {
  isHost = false;
  showScreen('join');
  document.getElementById('join-error').textContent = '';
  document.getElementById('join-room').value = '';
  document.getElementById('join-btn').textContent = '参加する';
  document.getElementById('join-btn').disabled = false;
  // Prefill saved name
  const savedName = (function() { try { return localStorage.getItem('watashibunko_name') || ''; } catch(e) { return ''; } })();
  if (savedName) document.getElementById('join-name').value = savedName;
}

function joinRoom(rejoinInfo) {
  const rid = rejoinInfo ? rejoinInfo.roomId : document.getElementById('join-room').value.trim();
  const name = rejoinInfo ? rejoinInfo.playerName : document.getElementById('join-name').value.trim();
  const isRejoin = !!rejoinInfo && !rejoinInfo._isRetry;
  const retryCount = rejoinInfo ? (rejoinInfo._retry || 0) : 0;
  const MAX_RETRIES = 1;

  if (!name) return;
  if (!/^[A-Z0-9]{5}$/.test(rid)) {
    if (!rejoinInfo) {
      document.getElementById('join-error').textContent = 'ルームコードは半角英数字5文字です。';
    }
    return;
  }
  roomId = rid;
  isHost = false;
  spectatorName = name;
  guestConnected = false;
  guestConnGen++;
  const myGen = guestConnGen;

  if (!isRejoin) {
    document.getElementById('join-error').textContent = '';
    document.getElementById('join-btn').textContent = retryCount > 0 ? '再試行中... (' + retryCount + '/' + MAX_RETRIES + ')' : '接続中...';
    document.getElementById('join-btn').disabled = true;
  }

  if (peer && !peer.destroyed && peer.open) {
    // Reuse existing peer — just create a new connection
    setupGuestConnection(peer, rid, name, myGen, isRejoin, retryCount, MAX_RETRIES);
  } else {
    if (peer && !peer.destroyed) peer.destroy();
    peer = new Peer(undefined, PEER_CONFIG);

    // Accept reverse connections from host (host actively reconnects to us)
    peer.on('connection', (reverseConn) => {
      reverseConn.on('open', () => {
        reverseConn.on('data', (d) => {
          if (d.type === 'rejoinState' && d.isReverseConnection) {
            dbg('GUEST reverse conn accepted!');
            hostConn = reverseConn;
            guestConnected = true;
            guestConnGen++;
            if (guestReconnectAttempt > 0) gtag('event', 'reconnect_success', { method: 'reverse', attempts: guestReconnectAttempt });
            resetReconnectAttempts();
            handleGuestMessage(d);
          } else {
            handleGuestMessage(d);
          }
        });
        reverseConn.on('close', () => {
          const shouldReconnect = currentScreenName !== 'title' && currentScreenName !== 'join'
            && (currentScreenName !== 'results' || isSpectator);
          if (shouldReconnect) {
            scheduleGuestReconnect(roomId, players[myIndex] || spectatorName);
          }
        });
      });
    });

    peer.on('open', () => {
      if (myGen !== guestConnGen) return;
      setupGuestConnection(peer, rid, name, myGen, isRejoin, retryCount, MAX_RETRIES);
    });

    peer.on('error', () => {
      if (myGen !== guestConnGen) return;
      if (!isRejoin) {
        if (retryCount < MAX_RETRIES) {
          setTimeout(() => {
            if (myGen !== guestConnGen) return;
            joinRoom({ roomId: rid, playerName: name, _retry: retryCount + 1, _isFirstJoin: true, _isRetry: true });
          }, 2000);
        } else {
          document.getElementById('join-error').textContent = 'ルームが見つかりません。ルームコード（5文字）が正しいか確認してください。';
          document.getElementById('join-btn').textContent = '参加する';
          document.getElementById('join-btn').disabled = false;
          gtag('event', 'join_fail', { reason: 'room_not_found' });
        }
      } else {
        scheduleGuestReconnect(rid, name);
      }
    });
  }

  if (!isRejoin || rejoinInfo._isFirstJoin) {
    setTimeout(() => {
      if (myGen !== guestConnGen) return;
      if (!guestConnected && document.getElementById('join-btn').disabled) {
        if (retryCount < MAX_RETRIES) {
          setTimeout(() => {
            if (myGen !== guestConnGen) return;
            joinRoom({ roomId: rid, playerName: name, _retry: retryCount + 1, _isFirstJoin: true, _isRetry: true });
          }, 1000);
        } else {
          document.getElementById('join-error').textContent = 'ホストが応答しません。ルームコード（5文字）を確認してください。ホストがアプリを開いていない可能性があります。';
          document.getElementById('join-btn').textContent = '参加する';
          document.getElementById('join-btn').disabled = false;
          gtag('event', 'join_fail', { reason: 'timeout' });
        }
      }
    }, 3000);
  }
}

function setupGuestConnection(guestPeer, rid, name, myGen, isRejoin, retryCount, MAX_RETRIES) {
  const conn = guestPeer.connect('watashibunko-' + rid);
  hostConn = conn;

  conn.on('open', () => {
    if (myGen !== guestConnGen) return;
    guestConnected = true;
    const token = getToken();
    conn.send({ type: 'join', name, token, guestPeerId: guestPeer.id });
  });

  conn.on('data', (d) => {
    if (myGen !== guestConnGen) return;
    handleGuestMessage(d);
  });

  conn.on('close', () => {
    if (myGen !== guestConnGen) return;
    const shouldReconnect = currentScreenName !== 'title' && currentScreenName !== 'join'
      && (currentScreenName !== 'results' || isSpectator);
    if (shouldReconnect) {
      scheduleGuestReconnect(rid, name);
    }
  });

  conn.on('error', () => {
    if (myGen !== guestConnGen) return;
    if (!isRejoin) {
      if (retryCount < MAX_RETRIES) {
        setTimeout(() => {
          if (myGen !== guestConnGen) return;
          joinRoom({ roomId: rid, playerName: name, _retry: retryCount + 1, _isFirstJoin: true, _isRetry: true });
        }, 2000);
      } else {
        document.getElementById('join-error').textContent = '接続に失敗しました。ネットワーク環境を確認し、もう一度お試しください。';
        document.getElementById('join-btn').textContent = '参加する';
        document.getElementById('join-btn').disabled = false;
        gtag('event', 'join_fail', { reason: 'network_error' });
      }
    } else {
      scheduleGuestReconnect(rid, name);
    }
  });
}

let guestReconnectAttempt = 0;
const MAX_RECONNECT_ATTEMPTS = 20;
let reconnectAttemptTimeout = null;

function scheduleGuestReconnect(rid, name) {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (reconnectAttemptTimeout) clearTimeout(reconnectAttemptTimeout);
  const reliableName = name || (function() {
    try {
      const gs = JSON.parse(localStorage.getItem('watashibunko_guest') || '{}');
      return gs.playerName || '';
    } catch(e) { return ''; }
  })();
  if (!reliableName || !rid) { dbg('GUEST reconnect: no name/rid, abort'); return; }
  guestReconnectAttempt++;
  dbg('GUEST reconnect attempt=' + guestReconnectAttempt + '/' + MAX_RECONNECT_ATTEMPTS + ' peer=' + (peer ? (peer.open ? 'open:' + peer.id : 'not-open') : 'null'));
  if (guestReconnectAttempt > MAX_RECONNECT_ATTEMPTS) {
    gtag('event', 'reconnect_fail', { attempts: MAX_RECONNECT_ATTEMPTS });
    hideDisconnectOverlay();
    guestConnGen++;
    isSpectator = false;
    stopHeartbeat();
    if (peer) { peer.destroy(); peer = null; }
    connections = []; hostConn = null;
    clearGuestState();
    showScreen('title');
    return;
  }
  const delay = Math.min(2000 + guestReconnectAttempt * 1000, 5000);
  reconnectTimer = setTimeout(() => {
    joinRoom({ roomId: rid, playerName: reliableName });
    const attemptGen = guestConnGen; // capture AFTER joinRoom increments it
    reconnectAttemptTimeout = setTimeout(() => {
      if (attemptGen !== guestConnGen) return;
      if (!guestConnected) {
        dbg('GUEST attempt timeout, forcing next retry');
        scheduleGuestReconnect(rid, reliableName);
      }
    }, 8000);
  }, delay);
}

function resetReconnectAttempts() {
  guestReconnectAttempt = 0;
  if (reconnectAttemptTimeout) { clearTimeout(reconnectAttemptTimeout); reconnectAttemptTimeout = null; }
}

// ===================== GUEST MESSAGE HANDLER =====================
function handleGuestMessage(data) {
  if (data.type === 'joined') {
    myIndex = data.playerIndex;
    players = data.players;
    if (data.token) { saveToken(data.token); }
    saveLastRoom(roomId, players[myIndex], data.token);
    gtag('event', 'join_room', { room_id: roomId });
    const rBtn = document.getElementById('rejoin-btn');
    if (rBtn._failTimer) { clearTimeout(rBtn._failTimer); rBtn._failTimer = null; }
    document.getElementById('lobby-title').textContent = '参加しました！';
    document.getElementById('lobby-subtitle').textContent = 'ホストがゲームを開始するのを待っています...';
    renderLobbyPlayers();
    hideDisconnectOverlay();
    resetReconnectAttempts();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    showScreen('lobby');
    saveGuestState();

  } else if (data.type === 'joinError') {
    gtag('event', 'join_fail', { reason: 'name_conflict' });
    const rBtn = document.getElementById('rejoin-btn');
    if (rBtn._failTimer) { clearTimeout(rBtn._failTimer); rBtn._failTimer = null; }
    document.getElementById('join-error').textContent = data.message;
    document.getElementById('join-btn').textContent = '参加する';
    document.getElementById('join-btn').disabled = false;
    showScreen('join');

  } else if (data.type === 'rejoinState') {
    myIndex = data.playerIndex;
    players = data.players;
    gameState = data.gameState;
    roundDone = new Set(data.roundDoneList || []);
    if (data.token) { saveToken(data.token); }
    const phase = data.gamePhase;
    hideDisconnectOverlay();
    if (guestReconnectAttempt > 0) gtag('event', 'reconnect_success', { attempts: guestReconnectAttempt });
    resetReconnectAttempts();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    const rBtn = document.getElementById('rejoin-btn');
    if (rBtn._failTimer) { clearTimeout(rBtn._failTimer); rBtn._failTimer = null; }
    saveLastRoom(roomId, players[myIndex], data.token);
    saveGuestState();

    if (phase === 'lobby') {
      renderLobbyPlayers();
      showScreen('lobby');
    } else if (phase === 'topic') {
      if (roomId) startGuestHeartbeat(roomId, players[myIndex] || '');
      const topicCount = data.topicsDone || 0;
      const topicTotal = data.topicsTotal || players.length;
      if (!data.topicAlreadySubmitted) {
        const savedTopic = (function() { try { return sessionStorage.getItem('watashibunko_topic') || ''; } catch(e) { return ''; } })();
        const draftTopic = loadTopicDraft();
        if (savedTopic) {
          // Auto-resend saved topic
          initTopicScreen(topicCount, topicTotal, true);
          document.getElementById('topic-input').value = savedTopic;
          saveTopicDraft(savedTopic);
          myTopicSubmitted = true;
          document.getElementById('topic-submitted-msg').classList.remove('hidden');
          document.getElementById('topic-submit-btn').textContent = '変更';
          setTopicSubmitStatus('sending');
          sendTopicWithRetry(savedTopic);
        } else {
          initTopicScreen(topicCount, topicTotal, true);
          if (draftTopic) {
            document.getElementById('topic-input').value = draftTopic;
            saveTopicDraft(draftTopic);
          }
        }
      } else {
        // Already submitted — show topic screen with submitted state
        const savedTopic = (function() { try { return sessionStorage.getItem('watashibunko_topic') || ''; } catch(e) { return ''; } })();
        const draftTopic = loadTopicDraft();
        initTopicScreen(topicCount, topicTotal, true);
        const topicToShow = savedTopic || draftTopic;
        if (topicToShow) {
          document.getElementById('topic-input').value = topicToShow;
          saveTopicDraft(topicToShow);
        }
        myTopicSubmitted = true;
        document.getElementById('topic-submitted-msg').classList.remove('hidden');
        document.getElementById('topic-submit-btn').textContent = '変更';
        setTopicSubmitStatus('confirmed');
      }
    } else if (phase === 'writing' && gameState) {
      if (roomId) startGuestHeartbeat(roomId, players[myIndex] || '');
      // Check draft status BEFORE startWritingRound resets mySubmitted
      const si = (function() {
        const np = gameState.numPlayers;
        const idx = myIndex;
        for (let s = 0; s < np; s++) {
          if (getWriterForStoryAtRound(s, gameState.currentRound, np, gameState.shifts) === idx) return s;
        }
        return -1;
      })();
      const hadLocalSubmit = wasDraftSubmitted(gameState.currentRound, si);
      const localDraft = loadDraft(gameState.currentRound, si);
      isRestoring = true;
      startWritingRound(gameState.currentRound);
      isRestoring = false;
      if (data.playerAlreadySubmitted) {
        mySubmitted = true;
        document.getElementById('write-submitted-msg').classList.remove('hidden');
        document.getElementById('write-submit-btn').textContent = '再提出';
        setSubmitStatus('confirmed');
      } else if (hadLocalSubmit && localDraft) {
        // We submitted locally but host didn't receive — auto-resubmit
        hostConn.send({ type: 'partSubmit', storyIndex: myStoryIndex, round: gameState.currentRound, text: localDraft, isResubmit: false });
        mySubmitted = true;
        myLastSubmittedText = localDraft;
        saveDraft();
        document.getElementById('write-submitted-msg').classList.remove('hidden');
        document.getElementById('write-submit-btn').textContent = '再提出';
        setSubmitStatus('sending');
      }
      updateWriteProgress(roundDone.size, gameState.numPlayers);
    } else if (phase === 'results' && gameState) {
      showResults();
    }
    // Restore countdown timer if active (skip if guest already has a running timer to avoid visual jump)
    if (data.timerRemainingSec > 0 && data.timerTotalSec > 0 && (phase === 'topic' || phase === 'writing')) {
      if (!countdownInterval) {
        startCountdown(phase === 'topic' ? 'topic' : 'writing', data.timerRemainingSec);
        countdownTotal = data.timerTotalSec * 1000;
      }
    }

  } else if (data.type === 'playerList') {
    players = data.players;
    renderLobbyPlayers();
  } else if (data.type === 'startTopicPhase') {
    const currentTopicVal = (document.getElementById('topic-input') && currentScreenName === 'topic')
      ? (document.getElementById('topic-input').value || '')
      : '';
    if (currentTopicVal.trim() && !myTopicSubmitted) {
      saveTopicDraft(currentTopicVal);
    } else if (currentScreenName !== 'topic') {
      clearTopicDraft();
    }
    if (!(currentScreenName === 'topic' && myTopicSubmitted)) {
      try { sessionStorage.removeItem('watashibunko_topic'); } catch(e) {}
    }
    topicAckReceived = false;
    if (topicRetryTimer) { clearTimeout(topicRetryTimer); topicRetryTimer = null; }
    if (roomId) startGuestHeartbeat(roomId, players[myIndex] || '');
    gtag('event', 'game_play', { role: 'guest', player_count: players.length });
    initTopicScreen(0, players.length, true);
  } else if (data.type === 'topicProgress') {
    updateTopicProgress(data.count, data.total);
  } else if (data.type === 'startWriting') {
    clearTopicDraft();
    gameState = data.gameState;
    if (roomId) startGuestHeartbeat(roomId, players[myIndex] || '');
    startWritingRound(gameState.currentRound);
  } else if (data.type === 'nextRound') {
    Object.assign(gameState, data.gameState);
    startWritingRound(gameState.currentRound);
  } else if (data.type === 'roundProgress') {
    // Detect if we missed a nextRound message
    if (gameState && data.round != null && data.round !== gameState.currentRound) {
      // We're behind — request full state by re-sending join
      if (hostConn && hostConn.open) {
        const token = getToken();
        hostConn.send({ type: 'join', name: players[myIndex], token });
      }
    } else {
      updateWriteProgress(data.count, gameState.numPlayers);
    }
  } else if (data.type === 'partAck') {
    partAckReceived = true;
    if (partRetryTimer) { clearTimeout(partRetryTimer); partRetryTimer = null; }
    setSubmitStatus('confirmed');
  } else if (data.type === 'topicAck') {
    topicAckReceived = true;
    if (topicRetryTimer) { clearTimeout(topicRetryTimer); topicRetryTimer = null; }
    setTopicSubmitStatus('confirmed');
  } else if (data.type === 'timerStart') {
    startCountdown(data.phase, data.totalSec);
  } else if (data.type === 'timeUp') {
    guestHandleTimeUp();
  } else if (data.type === 'showResults') {
    stopCountdown();
    clearTopicDraft();
    gameState = data.gameState;
    if (topicRetryTimer) { clearTimeout(topicRetryTimer); topicRetryTimer = null; }
    topicAckReceived = false;
    saveFinishedGame();
    stopHeartbeat();
    showResults();
  } else if (data.type === 'gameEnd') {
    stopCountdown();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (topicRetryTimer) { clearTimeout(topicRetryTimer); topicRetryTimer = null; }
    topicAckReceived = false;
    guestConnGen++;
    isSpectator = false;
    stopHeartbeat();
    clearGuestState();
    if (peer) { peer.destroy(); peer = null; }
    hostConn = null;
  } else if (data.type === 'hostDisbanded') {
    stopCountdown();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (topicRetryTimer) { clearTimeout(topicRetryTimer); topicRetryTimer = null; }
    topicAckReceived = false;
    guestConnGen++;
    isSpectator = false;
    stopHeartbeat();
    clearGuestState();
    if (peer) { peer.destroy(); peer = null; }
    hostConn = null;
    showScreen('title');
  } else if (data.type === 'spectatorState') {
    isSpectator = true;
    gameState = data.gameState;
    gtag('event', 'spectator_join');
    hideDisconnectOverlay();
    resetReconnectAttempts();
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    saveGuestState();
    saveLastRoom(roomId, spectatorName);
    if (gameState) {
      showResults();
      document.getElementById('results-subtitle').textContent = '👀 観戦中 — 物語が進行中です';
    } else {
      // Game hasn't started writing yet (e.g. still in topic phase)
      showScreen('lobby');
      document.getElementById('lobby-player-list').innerHTML = '';
      (data.players || []).forEach((p, i) => {
        const span = document.createElement('span');
        span.className = 'badge ' + (i === 0 ? 'badge-gold' : 'badge-green');
        span.textContent = (i === 0 ? '👑 ' : '') + p;
        document.getElementById('lobby-player-list').appendChild(span);
      });
      document.getElementById('lobby-title').textContent = '👀 観戦中';
      document.getElementById('lobby-subtitle').textContent = 'プレイヤーがタイトルを決めています...';
    }
  } else if (data.type === 'spectatorUpdate') {
    // Live update for spectators
    gameState = data.gameState;
    if (gameState) {
      if (currentScreenName !== 'results') {
        showResults();
      } else {
        const wasViewing = currentStoryView;
        renderResultsTabs();
        renderStory(wasViewing);
      }
      if (data.gamePhase === 'results') {
        document.getElementById('results-subtitle').textContent = gameState.stories.length + ' つの物語が完成しました';
        // Game finished — release spectator (same as gameEnd)
        saveFinishedGame();
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
        guestConnGen++;
        isSpectator = false;
        clearGuestState();
        if (peer) { peer.destroy(); peer = null; }
        hostConn = null;
      } else {
        document.getElementById('results-subtitle').textContent = '👀 観戦中 — 物語が進行中です（ラウンド ' + (gameState.currentRound + 1) + '/' + gameState.totalRounds + '）';
      }
    }
  } else if (data.type === 'ping') {
    // Heartbeat from host — reset timeout and send pong
    if (hostConn && hostConn.open) { try { hostConn.send({ type: 'pong' }); } catch(e) {} }
    if (roomId) resetHeartbeatTimeout(roomId, players[myIndex] || spectatorName);
  }
}

// ===================== GAME START =====================
function startGame() {
  topicsCollected = new Array(players.length);
  gamePhase = 'topic';
  gtag('event', 'game_start', { player_count: players.length, page_count: numPages });
  gtag('event', 'game_play', { role: 'host', player_count: players.length, page_count: numPages });
  initTopicScreen(0, players.length, true);
  broadcast({ type: 'startTopicPhase', timerSec });
  startHostHeartbeat();
  saveHostState();
  hostStartTimer('topic', timerSec);
}

// ===================== TOPIC =====================
function randomTopic() {
  const topic = generateRandomTopic();
  document.getElementById('topic-input').value = topic;
  saveTopicDraft(topic);
}

let topicsComplete = false;
let myTopicSubmitted = false;
const SS_TOPIC_DRAFT = 'watashibunko_topic_draft';

function saveTopicDraft(value) {
  try {
    const nextValue = value != null ? String(value) : document.getElementById('topic-input').value;
    sessionStorage.setItem(SS_TOPIC_DRAFT, nextValue);
  } catch(e) {}
}

function loadTopicDraft() {
  try { return sessionStorage.getItem(SS_TOPIC_DRAFT) || ''; } catch(e) { return ''; }
}

function clearTopicDraft() {
  try { sessionStorage.removeItem(SS_TOPIC_DRAFT); } catch(e) {}
}

function submitTopic() {
  const topic = document.getElementById('topic-input').value.trim();
  if (!topic) return;
  gtag('event', 'submit_topic');
  myTopicSubmitted = true;
  document.getElementById('topic-submitted-msg').classList.remove('hidden');
  document.getElementById('topic-submit-btn').textContent = '変更';
  saveTopicDraft(topic);
  try { sessionStorage.setItem('watashibunko_topic', topic); } catch(e) {}
  if (isHost) {
    topicsComplete = false;
    topicAckReceived = true;
    if (topicRetryTimer) { clearTimeout(topicRetryTimer); topicRetryTimer = null; }
    setTopicSubmitStatus('confirmed');
    handleTopicFromPlayer(0, topic);
  } else {
    setTopicSubmitStatus('sending');
    sendTopicWithRetry(topic);
  }
}

let topicAckReceived = false;
let topicRetryTimer = null;

function sendTopicWithRetry(topic, attempt) {
  attempt = attempt || 0;
  topicAckReceived = false;
  if (topicRetryTimer) clearTimeout(topicRetryTimer);
  try {
    if (hostConn && hostConn.open) {
      hostConn.send({ type: 'topicSubmit', topic });
    }
  } catch(e) {}
  // Retry up to 3 times if no ack within 5 seconds
  if (attempt < 3) {
    topicRetryTimer = setTimeout(() => {
      if (!topicAckReceived && myTopicSubmitted && currentScreenName === 'topic') {
        dbg('GUEST topicSubmit retry attempt=' + (attempt + 1));
        const latestTopic = (document.getElementById('topic-input').value || topic).trim() || topic;
        sendTopicWithRetry(latestTopic, attempt + 1);
      }
    }, 5000);
  }
}

function setTopicSubmitStatus(status) {
  const el = document.getElementById('topic-submitted-text');
  if (status === 'sending') {
    el.style.color = '#f0c040';
    el.textContent = '⏳ 送信中...';
  } else {
    el.style.color = '#4ecdc4';
    el.textContent = '✓ 決定済み（他のプレイヤーが決めるまで変更できます）';
  }
}

function updateTopicProgress(done, total) {
  document.getElementById('topic-done').textContent = done;
  document.getElementById('topic-total').textContent = total;
  document.getElementById('topic-progress').style.width = total > 0 ? (done / total * 100) + '%' : '0%';
  document.getElementById('host-panel-topic').classList.toggle('hidden', !isHost);
  if (isHost) renderHostTopicStatusInline();
}

function initTopicScreen(done, total, forceReset) {
  let preservedDraft = '';
  if (forceReset) {
    if (currentScreenName === 'topic' && !myTopicSubmitted) {
      const currentVal = (document.getElementById('topic-input').value || '').trim();
      if (currentVal) {
        saveTopicDraft(currentVal);
      }
    }
    preservedDraft = loadTopicDraft();
    if (topicRetryTimer) { clearTimeout(topicRetryTimer); topicRetryTimer = null; }
    topicAckReceived = false;
  }
  // Preserve input and status if user already submitted and we're already on topic screen
  if (!forceReset && myTopicSubmitted && currentScreenName === 'topic') {
    // Just update progress, don't reset input/status
    updateTopicProgress(done || 0, total || players.length);
    return;
  }
  if (!forceReset && myTopicSubmitted) {
    // Switching to topic screen but preserving submitted state
    updateTopicProgress(done || 0, total || players.length);
    showScreen('topic');
    return;
  }
  myTopicSubmitted = false;
  document.getElementById('topic-input').value = forceReset ? preservedDraft : '';
  document.getElementById('topic-submit-btn').textContent = '決定';
  document.getElementById('topic-submitted-msg').classList.add('hidden');
  updateTopicProgress(done || 0, total || players.length);
  showScreen('topic');
}

function handleTopicFromPlayer(pIdx, topic) {
  topicsCollected[pIdx] = topic;
  const count = topicsCollected.filter(t => t != null && t !== '').length;
  const total = topicsCollected.length;
  broadcast({ type: 'topicProgress', count: count, total: total });
  updateTopicProgress(count, total);
  saveHostState();
  if (count === total) {
    topicsComplete = true;
    stopCountdown();
    const np = total;
    const shifts = generateRotation(np, numPages);
    const stories = topicsCollected.map((t, i) => ({ title: t || '無題', parts: [], originalPlayerIndex: i }));
    // Shuffle story display order so position doesn't reveal authorship
    // Also ensure title creator ≠ first writer after shuffle
    for (let attempt = 0; attempt < 50; attempt++) {
      for (let i = stories.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [stories[i], stories[j]] = [stories[j], stories[i]];
      }
      const hasCollision = stories.some((s, si) => (si + shifts[0]) % np === s.originalPlayerIndex);
      if (!hasCollision) break;
    }
    gameState = { stories, currentRound: 0, totalRounds: numPages, shifts, numPlayers: np, players: [...players], anonymous: !!document.getElementById('anonymous-mode').checked, timerSec };
    gamePhase = 'writing';
    broadcast({ type: 'startWriting', gameState: JSON.parse(JSON.stringify(gameState)) });
    broadcastToSpectators();
    saveHostState();
    startWritingRound(0);
  }
}

// ===================== WRITING =====================
let isRestoring = false; // flag to prevent roundDone reset during host restore

function startWritingRound(round) {
  if (topicRetryTimer) { clearTimeout(topicRetryTimer); topicRetryTimer = null; }
  topicAckReceived = false;
  if (partRetryTimer) { clearTimeout(partRetryTimer); partRetryTimer = null; }
  partAckReceived = false;
  const idx = isHost ? 0 : myIndex;
  const np = gameState.numPlayers;
  let si = -1;
  for (let s = 0; s < np; s++) {
    if (getWriterForStoryAtRound(s, round, np, gameState.shifts) === idx) { si = s; break; }
  }
  myStoryIndex = si;
  mySubmitted = false;
  myLastSubmittedText = "";
  if (!isRestoring) {
    roundDone = new Set();
  }

  document.getElementById('write-title').textContent = '📖 ' + gameState.stories[si].title;
  document.getElementById('write-round').textContent = (round + 1) + ' / ' + gameState.totalRounds;

  const parts = gameState.stories[si].parts;
  // Find the last part from a previous round (not current round)
  let prevText = null;
  if (round > 0) {
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i]._round !== round) { prevText = parts[i].text; break; }
    }
  }
  if (prevText) {
    document.getElementById('write-prev').classList.remove('hidden');
    document.getElementById('write-prev-text').textContent = prevText;
  } else {
    document.getElementById('write-prev').classList.add('hidden');
  }

  document.getElementById('write-input').value = loadDraft(round, si);
  document.getElementById('write-submitted-msg').classList.add('hidden');
  document.getElementById('write-submit-btn').textContent = '送信';
  document.getElementById('write-submit-btn').disabled = false;
  updateCharCount();
  updateWriteProgress(isRestoring ? roundDone.size : 0, np);
  document.getElementById('host-panel-write').classList.toggle('hidden', !isHost);
  showScreen('writing');
  if (isHost && !isRestoring) {
    hostStartTimer('writing', gameState.timerSec || timerSec);
  }
}

const CHAR_LIMIT = 100;
const SS_DRAFT = 'watashibunko_draft';

function saveDraft() {
  try {
    const val = document.getElementById('write-input').value;
    const round = gameState ? gameState.currentRound : 0;
    sessionStorage.setItem(SS_DRAFT, JSON.stringify({ text: val, round, storyIndex: myStoryIndex, submitted: mySubmitted }));
  } catch(e) {}
}

function loadDraft(round, storyIndex) {
  try {
    const s = sessionStorage.getItem(SS_DRAFT);
    if (!s) return '';
    const d = JSON.parse(s);
    if (d.round === round && d.storyIndex === storyIndex) return d.text || '';
    return '';
  } catch(e) { return ''; }
}

function wasDraftSubmitted(round, storyIndex) {
  try {
    const s = sessionStorage.getItem(SS_DRAFT);
    if (!s) return false;
    const d = JSON.parse(s);
    return d.round === round && d.storyIndex === storyIndex && d.submitted === true;
  } catch(e) { return false; }
}

function clearDraft() {
  try { sessionStorage.removeItem(SS_DRAFT); } catch(e) {}
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
  saveDraft();
}

let roundAdvanced = false;

function submitPart() {
  const text = document.getElementById('write-input').value.trim();
  if (!text || text.length > CHAR_LIMIT) return;
  gtag('event', 'submit_part', { round: gameState ? gameState.currentRound + 1 : 0 });
  const isResubmit = mySubmitted;
  mySubmitted = true;
  myLastSubmittedText = text;
  saveDraft();

  document.getElementById('write-submitted-msg').classList.remove('hidden');
  document.getElementById('write-submit-btn').textContent = '再提出';

  if (isHost) {
    setSubmitStatus('confirmed');
    roundAdvanced = false;
    handlePartFromPlayer(0, myStoryIndex, gameState.currentRound, text, isResubmit);
    if (!roundAdvanced) {
      updateWriteProgress(roundDone.size, gameState.numPlayers);
    }
  } else {
    setSubmitStatus('sending');
    sendPartWithRetry(myStoryIndex, gameState.currentRound, text, isResubmit);
  }
}

let partAckReceived = false;
let partRetryTimer = null;

function sendPartWithRetry(storyIndex, round, text, isResubmit, attempt) {
  attempt = attempt || 0;
  partAckReceived = false;
  if (partRetryTimer) clearTimeout(partRetryTimer);
  try {
    if (hostConn && hostConn.open) {
      hostConn.send({ type: 'partSubmit', storyIndex, round, text, isResubmit });
    }
  } catch(e) {}
  // Retry up to 3 times if no ack within 5 seconds
  if (attempt < 3) {
    partRetryTimer = setTimeout(() => {
      if (!partAckReceived && mySubmitted && currentScreenName === 'writing') {
        dbg('GUEST partSubmit retry attempt=' + (attempt + 1));
        sendPartWithRetry(storyIndex, round, text, true, attempt + 1);
      }
    }, 5000);
  }
}

function setSubmitStatus(status) {
  const el = document.getElementById('write-submitted-text');
  if (status === 'sending') {
    el.style.color = '#f0c040';
    el.textContent = '⏳ 送信中...';
  } else {
    el.style.color = '#4ecdc4';
    el.textContent = '✓ 送信済み（他のプレイヤーが完了するまで再提出できます）';
  }
}

function handlePartFromPlayer(pIdx, storyIndex, round, text, isResubmit) {
  const pName = (gameState.players || players)[pIdx];
  if (isResubmit) {
    const parts = gameState.stories[storyIndex].parts;
    let found = false;
    for (let i = parts.length - 1; i >= 0; i--) {
      if (parts[i].author === pName && parts[i]._round === round) {
        parts[i].text = text;
        found = true;
        break;
      }
    }
    if (!found) {
      // First submission was lost — treat as new
      gameState.stories[storyIndex].parts.push({ author: pName, text, _round: round });
      roundDone.add(pIdx);
    }
  } else {
    gameState.stories[storyIndex].parts.push({ author: pName, text, _round: round });
    roundDone.add(pIdx);
  }
  const doneCount = roundDone.size;

  broadcast({ type: 'roundProgress', count: doneCount, round: gameState.currentRound });
  updateWriteProgress(doneCount, gameState.numPlayers);
  broadcastToSpectators();
  saveHostState();

  if (doneCount === gameState.numPlayers) {
    roundAdvanced = true;
    const next = gameState.currentRound + 1;
    if (next >= gameState.totalRounds) {
      gamePhase = 'results';
      gtag('event', 'game_complete', { player_count: gameState.numPlayers, page_count: gameState.totalRounds });
      broadcast({ type: 'showResults', gameState: JSON.parse(JSON.stringify(gameState)) });
      broadcastToSpectators();
      saveHostState();
      showResults();
    } else {
      gameState.currentRound = next;
      roundDone = new Set();
      gamePhase = 'writing';
      broadcast({ type: 'nextRound', gameState: JSON.parse(JSON.stringify(gameState)) });
      broadcastToSpectators();
      saveHostState();
      startWritingRound(next);
    }
  }
}

// ===================== COUNTDOWN TIMER =====================
let countdownDeadline = 0;
let countdownTotal = 0;
let countdownInterval = null;
let hostTimerTimeout = null;
let hostGraceTimeout = null;
let activeTimerPhase = ''; // track which phase timer is active for

function startCountdown(phase, totalSec) {
  stopCountdown();
  activeTimerPhase = phase;
  countdownTotal = totalSec * 1000;
  countdownDeadline = Date.now() + countdownTotal;
  const prefix = phase === 'topic' ? 'topic' : 'write';
  const timerEl = document.getElementById(prefix + '-timer');
  if (timerEl) timerEl.classList.remove('hidden');
  countdownInterval = setInterval(() => updateCountdownUI(prefix), 200);
  updateCountdownUI(prefix);
}

function stopCountdown() {
  if (countdownInterval) { clearInterval(countdownInterval); countdownInterval = null; }
  if (hostTimerTimeout) { clearTimeout(hostTimerTimeout); hostTimerTimeout = null; }
  if (hostGraceTimeout) { clearTimeout(hostGraceTimeout); hostGraceTimeout = null; }
  activeTimerPhase = '';
  countdownDeadline = 0;
  ['topic-timer', 'write-timer'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
}

function updateCountdownUI(prefix) {
  const remaining = Math.max(0, countdownDeadline - Date.now());
  const sec = Math.ceil(remaining / 1000);
  const min = Math.floor(sec / 60);
  const s = sec % 60;
  const textEl = document.getElementById(prefix + '-timer-text');
  const barEl = document.getElementById(prefix + '-timer-bar');
  if (!textEl || !barEl) return;
  textEl.textContent = min + ':' + String(s).padStart(2, '0');
  const pct = countdownTotal > 0 ? (remaining / countdownTotal) * 100 : 0;
  barEl.style.width = pct + '%';
  barEl.className = 'countdown-fill' + (pct <= 15 ? ' critical' : pct <= 33 ? ' urgent' : '');
  textEl.style.color = pct <= 15 ? '#e94560' : pct <= 33 ? '#f0c040' : '#4ecdc4';
}

// Host starts the authoritative timer for a phase
function hostStartTimer(phase, totalSec) {
  if (!isHost || !totalSec) return;
  broadcast({ type: 'timerStart', phase, totalSec });
  broadcastToSpectators();
  startCountdown(phase, totalSec);
  hostTimerTimeout = setTimeout(() => {
    hostEnforceTimeUp(phase);
  }, totalSec * 1000);
  saveHostState(); // persist timer deadline immediately
}

function restoreHostTimer(hostSaved, phase) {
  if (!hostSaved.timerDeadline || !hostSaved.timerPhase || hostSaved.timerPhase !== phase) return;
  const remaining = hostSaved.timerDeadline - Date.now();
  if (remaining <= 0) {
    // Timer already expired during reload — enforce immediately
    setTimeout(() => hostEnforceTimeUp(phase), 500);
    return;
  }
  const remainingSec = Math.ceil(remaining / 1000);
  const totalMs = hostSaved.timerTotalMs || (timerSec * 1000);
  startCountdown(phase, remainingSec);
  countdownTotal = totalMs;
  hostTimerTimeout = setTimeout(() => { hostEnforceTimeUp(phase); }, remaining);
  saveHostState(); // persist restored timer so double-reload works
}

function hostEnforceTimeUp(phase) {
  if (!isHost) return;
  // Stop current timer FIRST — before any handlePartFromPlayer that may start the next round's timer
  stopCountdown();
  // Notify all guests — they auto-submit current text
  broadcast({ type: 'timeUp' });

  // Capture current round BEFORE any handlePartFromPlayer that might advance it
  const frozenRound = gameState ? gameState.currentRound : -1;

  // Host self-submit immediately (host has local access to text)
  if (phase === 'topic') {
    if (topicsCollected[0] == null || topicsCollected[0] === '') {
      const topic = (document.getElementById('topic-input').value || '').trim() || '無題';
      myTopicSubmitted = true;
      document.getElementById('topic-submitted-msg').classList.remove('hidden');
      document.getElementById('topic-submit-btn').textContent = '変更';
      setTopicSubmitStatus('confirmed');
      handleTopicFromPlayer(0, topic);
    }
    // If topic phase already completed (all collected), skip grace period
    if (gamePhase !== 'topic') return;
    hostGraceTimeout = setTimeout(() => {
      if (gamePhase !== 'topic') return;
      for (let i = 0; i < topicsCollected.length; i++) {
        if (topicsCollected[i] == null || topicsCollected[i] === '') {
          handleTopicFromPlayer(i, '無題');
        }
      }
    }, 3000);
  } else if (phase === 'writing' && gameState) {
    if (!roundDone.has(0)) {
      const text = (document.getElementById('write-input').value || '').trim() || '……';
      const clipped = text.slice(0, CHAR_LIMIT);
      mySubmitted = true;
      myLastSubmittedText = clipped;
      document.getElementById('write-submitted-msg').classList.remove('hidden');
      setSubmitStatus('confirmed');
      document.getElementById('write-submit-btn').textContent = '再提出';
      handlePartFromPlayer(0, myStoryIndex, gameState.currentRound, clipped, false);
    }
    // If round already advanced after host submit, skip grace period
    if (!gameState || gamePhase !== 'writing' || gameState.currentRound !== frozenRound) return;
    hostGraceTimeout = setTimeout(() => {
      if (!gameState || gamePhase !== 'writing' || gameState.currentRound !== frozenRound) return;
      const np = gameState.numPlayers;
      for (let i = 0; i < np; i++) {
        if (!roundDone.has(i)) {
          for (let s = 0; s < np; s++) {
            if (getWriterForStoryAtRound(s, frozenRound, np, gameState.shifts) === i) {
              handlePartFromPlayer(i, s, frozenRound, '……', false);
              break;
            }
          }
        }
      }
    }, 3000);
  }
}

// Guest receives timeUp — auto-submit current text
function guestHandleTimeUp() {
  if (isHost) return;
  stopCountdown();
  if (currentScreenName === 'writing' && gameState && !mySubmitted) {
    const text = (document.getElementById('write-input').value || '').trim() || '……';
    const clipped = text.slice(0, CHAR_LIMIT);
    mySubmitted = true;
    myLastSubmittedText = clipped;
    saveDraft();
    document.getElementById('write-submitted-msg').classList.remove('hidden');
    setSubmitStatus('sending');
    document.getElementById('write-submit-btn').textContent = '再提出';
    sendPartWithRetry(myStoryIndex, gameState.currentRound, clipped, false);
  } else if (currentScreenName === 'topic' && !myTopicSubmitted) {
    const topic = (document.getElementById('topic-input').value || '').trim() || '無題';
    myTopicSubmitted = true;
    document.getElementById('topic-submitted-msg').classList.remove('hidden');
    document.getElementById('topic-submit-btn').textContent = '変更';
    setTopicSubmitStatus('sending');
    sendTopicWithRetry(topic);
  }
}

// Foreground recovery: update countdown and trigger timeUp if expired while in background
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  if (countdownDeadline > 0 && Date.now() >= countdownDeadline && !isHost) {
    // Timer expired while guest was in background — trigger auto-submit
    guestHandleTimeUp();
    return;
  }
  if (countdownInterval) {
    const prefix = (currentScreenName === 'topic') ? 'topic' : 'write';
    updateCountdownUI(prefix);
  }
});

// ===================== PROGRESS =====================
function updateWriteProgress(done, total) {
  document.getElementById('write-done').textContent = done;
  document.getElementById('write-total').textContent = total;
  document.getElementById('write-progress').style.width = (done / total * 100) + '%';
  if (isHost) renderHostWriteStatus();
}

// ===================== HOST-ONLY STATUS =====================
function renderHostTopicStatusInline() {
  const el = document.getElementById('host-topic-status-inline');
  if (!isHost || !el) return;
  let html = '<p style="font-size:12px;color:#8899aa;margin-bottom:6px;font-family:\'Noto Sans JP\',sans-serif;">提出状況：</p><div style="display:flex;flex-wrap:wrap;gap:6px;">';
  for (let i = 0; i < topicsCollected.length; i++) {
    const p = players[i] || ('Player ' + (i + 1));
    const done = topicsCollected[i] != null && topicsCollected[i] !== '';
    const color = done ? '#4ecdc4' : '#555';
    const icon = done ? '✓' : '…';
    html += '<span style="font-size:12px;padding:3px 8px;border-radius:12px;background:' + (done ? 'rgba(78,205,196,0.15)' : 'rgba(255,255,255,0.05)') + ';color:' + color + ';font-family:\'Noto Sans JP\',sans-serif;">' + icon + ' ' + escHtml(p) + '</span>';
  }
  html += '</div>';
  el.innerHTML = html;
}

function renderHostWriteStatus() {
  const el = document.getElementById('host-write-status');
  if (!isHost || !gameState) return;
  let html = '<p style="font-size:12px;color:#8899aa;margin-bottom:6px;font-family:\'Noto Sans JP\',sans-serif;">提出状況：</p><div style="display:flex;flex-wrap:wrap;gap:6px;">';
  for (let i = 0; i < gameState.numPlayers; i++) {
    const p = players[i] || gameState.players[i] || ('Player ' + i);
    const done = roundDone.has(i);
    const color = done ? '#4ecdc4' : '#555';
    const icon = done ? '✓' : '…';
    html += '<span style="font-size:12px;padding:3px 8px;border-radius:12px;background:' + (done ? 'rgba(78,205,196,0.15)' : 'rgba(255,255,255,0.05)') + ';color:' + color + ';font-family:\'Noto Sans JP\',sans-serif;">' + icon + ' ' + escHtml(p) + '</span>';
  }
  html += '</div>';
  el.innerHTML = html;
}

// ===================== RESULTS =====================
let currentStoryView = 0;
let currentTheme = STORY_THEMES[0];

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
  renderStory(currentStoryView);
  try { localStorage.setItem('watashibunko_theme', themeId); } catch(e) {}
}

function restoreTheme() {
  try {
    const saved = localStorage.getItem('watashibunko_theme');
    if (saved) { applyTheme(saved); return; }
  } catch(e) {}
  applyTheme('midnight');
}

function changeStoryFont(fontFamily) {
  gtag('event', 'change_font', { font: fontFamily });
  document.getElementById('results-story').style.fontFamily = fontFamily;
  document.getElementById('story-font-select').style.fontFamily = fontFamily;
  try { localStorage.setItem('watashibunko_storyfont', fontFamily); } catch(e) {}
}

function restoreStoryFont() {
  try {
    const saved = localStorage.getItem('watashibunko_storyfont');
    if (saved) {
      document.getElementById('results-story').style.fontFamily = saved;
      document.getElementById('story-font-select').value = saved;
      document.getElementById('story-font-select').style.fontFamily = saved;
    }
  } catch(e) {}
}

function showResults() {
  stopCountdown();
  currentStoryView = 0;
  document.getElementById('results-subtitle').textContent = gameState.stories.length + ' つの物語が完成しました';
  renderThemeSelector();
  restoreTheme();
  renderResultsTabs();
  renderStory(0);
  restoreStoryFont();
  showScreen('results');
}

function renderResultsTabs() {
  const cont = document.getElementById('results-tabs');
  cont.innerHTML = '';
  gameState.stories.forEach((s, i) => {
    const btn = document.createElement('button');
    btn.className = 'story-tab' + (i === currentStoryView ? ' active' : '');
    btn.textContent = s.title;
    btn.onclick = () => { currentStoryView = i; renderResultsTabs(); renderStory(i); };
    cont.appendChild(btn);
  });
}

function getPlayerColor(authorName) {
  const idx = (gameState.players || []).indexOf(authorName);
  return PLAYER_COLORS[Math.max(0, idx) % PLAYER_COLORS.length];
}

function renderStory(idx) {
  const story = gameState.stories[idx];
  const t = currentTheme;
  const anon = gameState.anonymous;
  let html = '<h3 style="font-size:22px;text-align:center;margin-bottom:24px;color:' + t.title + ';">「' + escHtml(story.title) + '」</h3>';
  story.parts.forEach((part, i) => {
    const color = anon ? t.meta : getPlayerColor(part.author);
    html += '<div class="part-block" style="border-left:3px solid ' + color + ';">';
    if (anon) {
      html += '<p style="font-size:12px;margin-bottom:4px;color:' + t.meta + ';">ページ ' + (i + 1) + '</p>';
    } else {
      html += '<p style="font-size:12px;margin-bottom:4px;"><span style="color:' + color + ';font-weight:700;">' + escHtml(part.author) + '</span> <span style="color:' + t.meta + ';">— ページ ' + (i + 1) + '</span></p>';
    }
    html += '<p style="font-size:16px;line-height:1.8;white-space:pre-wrap;">' + escHtml(part.text) + '</p>';
    html += '</div>';
  });
  document.getElementById('results-story').innerHTML = html;
}

// ===================== ABORT GAME =====================
function confirmAbortGame() {
  if (!isHost) return;
  if (gameState) {
    if (confirm('ゲームを中断しますか？\n全員の画面が結果表示に切り替わります。')) {
      abortGame();
    }
  } else {
    if (confirm('ゲームを中断しますか？\n全員がタイトル画面に戻ります。')) {
      abortGameToTitle();
    }
  }
}

function abortGame() {
  if (!isHost || !gameState) return;
  gtag('event', 'game_abort', { phase: gamePhase, round: gameState.currentRound, total_rounds: gameState.totalRounds });
  gamePhase = 'results';
  broadcast({ type: 'showResults', gameState: JSON.parse(JSON.stringify(gameState)) });
  broadcastToSpectators();
  saveHostState();
  showResults();
  document.getElementById('results-subtitle').textContent = gameState.stories.length + ' つの物語（中断）';
}

function abortGameToTitle() {
  if (!isHost) return;
  gtag('event', 'game_abort', { phase: gamePhase, action: 'back_to_title' });
  broadcast({ type: 'hostDisbanded' });
  spectators.forEach(c => { if (c.open) c.send({ type: 'hostDisbanded' }); });
  setTimeout(() => {
    if (peer) { peer.destroy(); peer = null; }
    connections = []; spectators = []; hostConn = null; players = [];
    gameState = null; topicsCollected = []; roundDone = new Set();
    playerTokens = [];
    gamePhase = 'idle';
    clearHostState();
    clearGuestState();
    clearFinishedGame();
    try { sessionStorage.removeItem('watashibunko_token'); sessionStorage.removeItem('watashibunko_topic'); sessionStorage.removeItem('watashibunko_topic_draft'); } catch(e) {}
    clearDraft();
    stopHeartbeat();
    showScreen('title');
  }, 100);
}

// ===================== PLAY AGAIN =====================
function playAgain() {
  stopCountdown();
  // Save player name for next game
  const myName = isHost ? (players[0] || '') : (players[myIndex] || '');
  if (myName) { try { localStorage.setItem('watashibunko_name', myName); } catch(e) {} }
  // Prevent reconnect from firing during cleanup
  guestConnGen++;
  isSpectator = false;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  // Notify guests and spectators that the game is over
  if (isHost) {
    broadcast({ type: 'gameEnd' });
    spectators.forEach(c => { if (c.open) c.send({ type: 'gameEnd' }); });
  }
  // Small delay to let the message send before destroying peer
  setTimeout(() => {
    if (peer) { peer.destroy(); peer = null; }
    connections = []; spectators = []; hostConn = null; players = [];
    gameState = null; topicsCollected = []; roundDone = new Set();
    playerTokens = [];
    gamePhase = 'idle';
    clearHostState();
    clearGuestState();
    clearFinishedGame();
    try { sessionStorage.removeItem('watashibunko_token'); sessionStorage.removeItem('watashibunko_topic'); sessionStorage.removeItem('watashibunko_topic_draft'); } catch(e) {}
    clearDraft();
    stopHeartbeat();
    showScreen('title');
  }, 100);
}

// ===================== COPY & SCREENSHOT =====================
function toggleCopyMenu() {
  const menu = document.getElementById('copy-menu');
  menu.style.display = menu.style.display === 'none' ? 'block' : 'none';
}

function hideCopyMenu() {
  document.getElementById('copy-menu').style.display = 'none';
}

// Close menu when clicking elsewhere
document.addEventListener('click', (e) => {
  const menu = document.getElementById('copy-menu');
  if (menu && menu.style.display === 'block' && !e.target.closest('#copy-menu') && !e.target.closest('[onclick*="toggleCopyMenu"]')) {
    menu.style.display = 'none';
  }
});

function copyStoryAsText(mode) {
  gtag('event', 'copy_story', { mode: mode });
  const story = gameState.stories[currentStoryView];
  let text = '';

  if (mode === 'simple') {
    text += '「' + story.title + '」\n\n';
    story.parts.forEach((part) => {
      text += part.text + '\n\n';
    });
    text = text.trimEnd();
  } else {
    text += '📖 じゃれ本（餅天）\n';
    text += '━━━━━━━━━━━━━━━━\n';
    text += '「' + story.title + '」\n';
    text += '━━━━━━━━━━━━━━━━\n\n';
    story.parts.forEach((part, i) => {
      if (gameState.anonymous) {
        text += '【ページ ' + (i + 1) + '】\n';
      } else {
        text += '【ページ ' + (i + 1) + '】' + part.author + '\n';
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
    const story = gameState.stories[currentStoryView];
    link.download = 'じゃれ本（餅天）_' + story.title.slice(0, 10) + '.png';
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
window.addEventListener('load', () => {
  // Try host restore first
  const hostSaved = loadHostState();
  if (hostSaved && hostSaved.gamePhase !== 'idle') {
    isHost = true;
    myIndex = 0;
    roomId = hostSaved.roomId;
    numPages = hostSaved.numPages;
    timerSec = hostSaved.timerSec || 0;
    players = hostSaved.players || [];
    topicsCollected = (hostSaved.topicsCollected || []).map(t => t == null ? undefined : t);
    gameState = hostSaved.gameState;
    roundDone = new Set(hostSaved.roundDoneList || []);
    playerTokens = hostSaved.playerTokens || [];
    gamePhase = hostSaved.gamePhase;

    initHostPeer(roomId);

    if (gamePhase === 'lobby') {
      document.getElementById('host-room-code').textContent = roomId;
      document.getElementById('host-name').value = players[0] || '';
      renderPageSelect();
      renderTimerSelect();
      renderHostPlayers();
      showScreen('host');
      document.getElementById('host-name').addEventListener('input', () => {
        players[0] = document.getElementById('host-name').value.trim() || 'ホスト';
        renderHostPlayers(); saveHostState();
      });
    } else if (gamePhase === 'topic') {
      const count = topicsCollected.filter(t => t != null && t !== '').length;
      initTopicScreen(count, topicsCollected.length, true);
      // Restore host's submitted state if applicable
      if (topicsCollected[0] != null && topicsCollected[0] !== '') {
        myTopicSubmitted = true;
        document.getElementById('topic-input').value = topicsCollected[0];
        document.getElementById('topic-submitted-msg').classList.remove('hidden');
        document.getElementById('topic-submit-btn').textContent = '変更';
        setTopicSubmitStatus('confirmed');
      }
      startHostHeartbeat();
      restoreHostTimer(hostSaved, 'topic');
    } else if (gamePhase === 'writing' && gameState) {
      isRestoring = true;
      startWritingRound(gameState.currentRound);
      if (roundDone.has(0)) {
        mySubmitted = true;
        document.getElementById('write-submitted-msg').classList.remove('hidden');
        document.getElementById('write-submit-btn').textContent = '再提出';
      }
      isRestoring = false;
      restoreHostTimer(hostSaved, 'writing');
    } else if (gamePhase === 'results' && gameState) {
      showResults();
    }
    return;
  }

  // Try guest/spectator restore
  const guestSaved = loadGuestState();
  if (guestSaved && guestSaved.roomId && guestSaved.playerName) {
    // Auto-reconnect to host (works for both players and spectators)
    isSpectator = guestSaved.isSpectator || false;
    spectatorName = guestSaved.playerName;
    showDisconnectOverlay();
    joinRoom({ roomId: guestSaved.roomId, playerName: guestSaved.playerName });
    return;
  }

  // Try finished game restore (for reload after game ended)
  const finishedSaved = loadFinishedGame();
  if (finishedSaved && finishedSaved.gameState) {
    gameState = finishedSaved.gameState;
    showResults();
    return;
  }

  // On title screen — update rejoin button
  updateRejoinButton();
});

// ===================== AUTO-UPDATE CHECK =====================
let _lastUpdateCheck = Date.now(); // skip check for first 60s after load
const UPDATE_CHECK_INTERVAL = 60 * 1000; // minimum 60 seconds between checks

function checkForUpdate() {
  if (gamePhase !== 'idle' || currentScreenName !== 'title') return;
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
    .catch(() => {}); // silently ignore network errors
}

// Check on tab becoming visible (any screen, but only acts on title)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkForUpdate();
});

// ===================== DEBUG OVERLAY =====================
initDebug(document.getElementById('debug-log'));

// Triple-tap version number to toggle debug overlay
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
    if (newState) dbg('Debug ON | role=' + (isHost?'HOST':'GUEST') + ' phase=' + gamePhase + ' players=' + JSON.stringify(players));
  }
});

// ===================== EXPOSE TO onclick HANDLERS =====================
// HTML uses inline `onclick="..."` attributes which only see globals.
// Module-scope functions don't auto-attach to window, so do it explicitly.
Object.assign(window, {
  showHostSetup, showJoin, rejoinLastRoom, backToTitle, leaveLobby,
  copyRoomCode, copyRoomCodeBadge, dismissDisconnect,
  startGame, randomTopic, saveTopicDraft, submitTopic,
  confirmAbortGame, updateCharCount, submitPart,
  joinRoom,
  changeStoryFont, toggleCopyMenu, hideCopyMenu, copyStoryAsText, saveStoryAsImage,
  playAgain,
});
