// public/js/client.js
const socket = io();

let teamCode = null;
let playerId = null;
let me = { id: null, name: null };
let lobby = null;
let currentRole = null;

function $(id) { return document.getElementById(id); }

const saved = JSON.parse(localStorage.getItem('pvt:session') || 'null');
if (saved?.teamCode && saved?.playerId) {
  socket.emit('player:reconnect', saved);
}

// Event listeners
$('createBtn').onclick = () => {
  const hostName = $('hostName').value.trim() || 'Host';
  const totalRounds = Number($('rounds').value) || 10;
  socket.emit('lobby:create', { hostName, totalRounds });
};

$('joinBtn').onclick = () => {
  const code = $('joinCode').value.trim().toUpperCase();
  const playerName = $('playerName').value.trim() || 'Player';
  socket.emit('lobby:join', { teamCode: code, playerName });
};

$('startBtn').onclick = () => {
  if (!teamCode || !playerId) return;
  socket.emit('round:start', { teamCode, playerId });
};

$('dismantleBtn').onclick = () => {
    if (!teamCode || !playerId) return;
    socket.emit('lobby:dismantle', { teamCode, playerId });
};

$('guessBtn').onclick = () => {
  const targetId = $('guessSelect').value;
  socket.emit('police:guess', { teamCode, playerId, targetId });
  $('policeAction').style.display = 'none';
};

// Socket event handlers
socket.on('lobby:created', (payload) => {
  teamCode = payload.teamCode;
  playerId = payload.playerId;
  me.id = playerId;
  localStorage.setItem('pvt:session', JSON.stringify({ teamCode, playerId }));
  $('lobbyInfo').textContent = `Team Code: ${teamCode}`;
});

socket.on('lobby:joined', (payload) => {
  teamCode = payload.teamCode;
  playerId = payload.playerId;
  me.id = playerId;
  localStorage.setItem('pvt:session', JSON.stringify({ teamCode, playerId }));
  $('lobbyInfo').textContent = `Team Code: ${teamCode}`;
});

socket.on('lobby:update', (state) => {
  lobby = state;
  const { players, hostId, status, round, totalRounds, order } = state;
  let starterName = 'N/A';
  let isMyTurnToStart = false;
  if (order && order.length > 0) {
    const starterId = order[round % order.length];
    isMyTurnToStart = playerId === starterId;
    starterName = players.find(p => p.id === starterId)?.name || 'Next player';
  }

  if (playerId === hostId) {
    $('dismantleBtn').style.display = 'block';
  } else {
    $('dismantleBtn').style.display = 'none';
  }

  const canStart = status === 'lobby' || status === 'revealing';
  $('startBtn').disabled = !isMyTurnToStart || !canStart;
  const statusText = (status === 'lobby' || status === 'revealing') && status !== 'ended'
    ? `Waiting for ${starterName} to start`
    : `Status: ${status}`;
  $('lobbyInfo').textContent = `Team Code: ${state.teamCode} — Round ${round}/${totalRounds} — ${statusText}`;

  const rows = players.map(p => `<div class="row"><span class="pill mono">${p.id.slice(0, 8)}</span><b>${p.name}</b><span class="muted">${p.connected ? 'online' : 'offline'}</span><span class="pill">${p.score} pts</span></div>`);
  $('players').innerHTML = rows.join('') || '—';

  const table = `<table><thead><tr><th>Player</th><th>Total</th></tr></thead><tbody>
    ${players.map(p => `<tr><td>${p.name}</td><td class="mono">${p.score}</td></tr>`).join('')}
  </tbody></table>`;
  $('scoreboard').innerHTML = table;

  if (state.history?.length) {
    $('history').innerHTML = state.history.map(h => {
      const getName = id => players.find(p => p.id === id)?.name || id;
      return `<div class="card" style="background:#0b1220;margin:8px 0;">
        <div><b>Round ${h.round}</b> — Police: ${getName(h.policeId)} — Guess: ${getName(h.guess.by)} ➜ ${getName(h.guess.targetId)} (${h.guess.correct ? '<span class=success>Correct</span>' : '<span class=danger>Wrong</span>'})</div>
        <div class="muted">Thief: ${getName(h.thiefId)}</div>
        <div style="margin-top:6px">Δ Points: ${Object.entries(h.delta).map(([id, v]) => `${getName(id)}: <span class=mono>${v}</span>`).join(' | ')}</div>
      </div>`;
    }).join('');
  } else {
    $('history').textContent = '—';
  }
});

socket.on('round:role', ({ role, points }) => {
  currentRole = role;
  $('roleBadge').textContent = role ? `${role} (${points})` : '';
  if (role === 'POLICE') {
    $('policeAction').style.display = 'block';
  } else {
    $('policeAction').style.display = 'none';
  }
});

socket.on('round:police_revealed', ({ round, policeId, policeName }) => {
  if (playerId === policeId) {
    const opts = (lobby?.players || []).filter(p => p.id !== policeId).map(p => `<option value="${p.id}">${p.name}</option>`).join('');
    $('guessSelect').innerHTML = opts;
  }
});

socket.on('round:result', ({ round, correct, police, thief, civilians, delta, totals }) => {
  const civStr = civilians.map(c => `${c.name} (${c.pts})`).join(', ');
  $('roundResult').innerHTML = `<div>Round <b>${round}</b>: ${correct ? '<span class=success>Police guessed correctly</span>' : '<span class=danger>Police guessed wrong</span>'}</div>
  <div class="muted">Police: ${police.name} — Thief: ${thief.name}</div>
  <div>Civilians: ${civStr}</div>
  <div style="margin-top:6px">Δ: ${Object.entries(delta).map(([id, v]) => `<span class=mono>${(lobby?.players || []).find(p => p.id === id)?.name || id}</span>=${v}`).join(' | ')}</div>`;
  $('roleBadge').textContent = '';
  currentRole = null;
});

socket.on('game:ended', ({ winners, totals }) => {
  const names = winners.map(w => w.name).join(', ');
  $('roundResult').innerHTML = `<div class="warn"><b>Game Over</b></div><div>Winner(s): ` + names + `</div>`;
  $('startBtn').disabled = true;
  $('policeAction').style.display = 'none';
  localStorage.removeItem('pvt:session');
  teamCode = null;
  playerId = null;
  me = { id: null, name: null };
});

socket.on('game:dismantled', (payload) => {
    alert(payload.message);
    localStorage.removeItem('pvt:session');
    teamCode = null;
    playerId = null;
    me = { id: null, name: null };
    $('lobbyInfo').textContent = 'No lobby yet.';
    $('players').innerHTML = '';
    $('scoreboard').innerHTML = '—';
    $('history').innerHTML = '—';
    $('roundResult').innerHTML = '—';
    $('roleBadge').textContent = '';
    $('startBtn').style.display = 'block';
    $('policeAction').style.display = 'none';
    $('dismantleBtn').style.display = 'none';
});

socket.on('error:toast', (msg) => {
  alert(msg);
});