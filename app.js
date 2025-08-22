// app.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*'
    }
});

const PORT = process.env.PORT || 3000;

// Serve static files from the 'public' directory
app.use(express.static(path.join(__dirname, 'public')));

// -------------------------------
// In-memory game store
// -------------------------------
/** @type {Map<string, any>} */
const games = new Map(); // teamCode → GameState

// Civilians static points descending (extend as needed)
const CIVILIAN_POINTS = [900, 800, 700, 600, 500, 400, 300, 200];
const POLICE_WIN = 1000;
const THIEF_WIN = 1000; // thief wins if police guesses wrong

function makeTeamCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let s = '';
    for (let i = 0; i < 6; i++) s += chars[(Math.random() * chars.length) | 0];
    return s;
}

function getPublicPlayers(state) {
    return Array.from(state.players.values()).map(p => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
    }));
}

function broadcastLobby(state) {
    io.to(state.teamCode).emit('lobby:update', {
        teamCode: state.teamCode,
        hostId: state.hostId,
        players: getPublicPlayers(state),
        totalRounds: state.totalRounds,
        round: state.round,
        status: state.status,
        order: state.order,
        history: state.history,
    });
}

function assignRoles(state) {
    const ids = Array.from(state.players.keys());
    // shuffle
    for (let i = ids.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [ids[i], ids[j]] = [ids[j], ids[i]];
    }
    const policeId = ids[0];
    const thiefId = ids[1];
    const civIds = ids.slice(2);
    const civilians = civIds.map((id, idx) => ({
        id,
        pts: CIVILIAN_POINTS[idx] || 100
    }));
    state.roles = {
        policeId,
        thiefId,
        civilians
    };
}

function currentTotals(state) {
    const totals = {};
    for (const [id, p] of state.players) totals[id] = p.score;
    return totals;
}

function startRound(state) {
    state.round += 1;
    state.status = 'assigning';
    assignRoles(state);

    // Secretly tell each player their role
    const { policeId, thiefId, civilians } = state.roles;
    const civMap = new Map(civilians.map(c => [c.id, c.pts]));

    for (const [id, p] of state.players) {
        const socketId = p.socketId;
        if (!socketId) continue;
        if (id === policeId) {
            io.to(socketId).emit('round:role', { role: 'POLICE', points: POLICE_WIN });
        } else if (id === thiefId) {
            io.to(socketId).emit('round:role', { role: 'THIEF', points: 0 });
        } else {
            io.to(socketId).emit('round:role', { role: 'CIVILIAN', points: civMap.get(id) || 0 });
        }
    }

    // Reveal only who the police is (to everyone)
    io.to(state.teamCode).emit('round:police_revealed', {
        round: state.round,
        policeId,
        policeName: state.players.get(policeId)?.name,
    });

    state.status = 'guessing';
    broadcastLobby(state);
}

function endRoundWithGuess(state, guesserId, targetId) {
    const { policeId, thiefId, civilians } = state.roles;
    const correct = targetId === thiefId;

    // Compute deltas
    const delta = {};
    for (const [id] of state.players) delta[id] = 0;

    if (correct) {
        delta[policeId] = POLICE_WIN;
        delta[thiefId] = 0;
    } else {
        delta[policeId] = 0;
        delta[thiefId] = THIEF_WIN;
    }
    for (const c of civilians) delta[c.id] = (delta[c.id] || 0) + (c.pts || 0);

    // Apply scores
    for (const [id, p] of state.players) p.score += delta[id] || 0;

    const totals = currentTotals(state);

    // Record history
    state.history.push({
        round: state.round,
        policeId,
        thiefId,
        civilians,
        guess: { by: guesserId, targetId, correct },
        delta,
        totals,
    });

    // Reveal results to everyone
    io.to(state.teamCode).emit('round:result', {
        round: state.round,
        correct,
        police: { id: policeId, name: state.players.get(policeId)?.name },
        thief: { id: thiefId, name: state.players.get(thiefId)?.name },
        civilians: civilians.map(c => ({
            id: c.id,
            name: state.players.get(c.id)?.name,
            pts: c.pts
        })),
        delta,
        totals,
    });

    state.status = 'revealing';
    state.roles = null;

    if (state.round >= state.totalRounds) {
        state.status = 'ended';
        const maxScore = Math.max(...Array.from(state.players.values()).map(p => p.score));
        const winners = getPublicPlayers(state).filter(p => p.score === maxScore);
        io.to(state.teamCode).emit('game:ended', { winners, totals: currentTotals(state) });
    }

    broadcastLobby(state);
}

function findGame(teamCode) {
    const state = games.get(teamCode);
    if (!state) throw new Error('Game not found');
    return state;
}

// -------------------------------
// Socket events
// -------------------------------
io.on('connection', (socket) => {
    // Create lobby
    socket.on('lobby:create', ({ hostName, totalRounds }) => {
        const teamCode = makeTeamCode();
        const hostId = randomUUID();
        const state = {
            teamCode,
            hostId,
            players: new Map(),
            totalRounds: Math.max(1, Math.min(50, Number(totalRounds) || 10)),
            round: 0,
            order: [],
            status: 'lobby',
            roles: null,
            history: [],
        };

        state.players.set(hostId, { id: hostId, name: hostName || 'Host', socketId: socket.id, score: 0, connected: true });
        state.order = Array.from(state.players.keys());
        games.set(teamCode, state);
        socket.join(teamCode);
        socket.emit('lobby:created', { teamCode, playerId: hostId });
        broadcastLobby(state);
    });

    // Dismantle lobby
    socket.on('lobby:dismantle', ({ teamCode, playerId }) => {
        try {
            const state = findGame(teamCode);
            if (playerId !== state.hostId) {
                return socket.emit('error:toast', 'Only the host can dismantle the lobby.');
            }
            io.to(state.teamCode).emit('game:dismantled', { message: 'The host has dismantled the lobby.' });
            games.delete(teamCode);
            console.log(`Lobby ${teamCode} dismantled.`);
        } catch (e) {
            socket.emit('error:toast', e.message || 'Dismantle failed.');
        }
    });

    // Join lobby
    socket.on('lobby:join', ({ teamCode, playerName }) => {
        try {
            const state = findGame(teamCode);
            const playerId = randomUUID();
            state.players.set(playerId, { id: playerId, name: playerName || 'Player', socketId: socket.id, score: 0, connected: true });
            state.order = Array.from(state.players.keys());
            socket.join(teamCode);
            socket.emit('lobby:joined', { teamCode, playerId });
            broadcastLobby(state);
        } catch (e) {
            socket.emit('error:toast', e.message || 'Join failed');
        }
    });

    // Reconnect
    socket.on('player:reconnect', ({ teamCode, playerId }) => {
        try {
            const state = findGame(teamCode);
            const p = state.players.get(playerId);
            if (!p) return socket.emit('error:toast', 'Unknown player');
            p.socketId = socket.id;
            p.connected = true;
            socket.join(teamCode);
            if (state.status === 'guessing' && state.roles) {
                const { policeId, thiefId, civilians } = state.roles;
                const civMap = new Map(civilians.map(c => [c.id, c.pts]));
                if (playerId === policeId) io.to(socket.id).emit('round:role', { role: 'POLICE', points: POLICE_WIN });
                else if (playerId === thiefId) io.to(socket.id).emit('round:role', { role: 'THIEF', points: 0 });
                else io.to(socket.id).emit('round:role', { role: 'CIVILIAN', points: civMap.get(playerId) || 0 });
                io.to(socket.id).emit('round:police_revealed', { round: state.round, policeId, policeName: state.players.get(policeId)?.name });
            }
            broadcastLobby(state);
        } catch (e) {
            socket.emit('error:toast', e.message || 'Reconnect failed');
        }
    });

    // Start next round (player in order)
    socket.on('round:start', ({ teamCode, playerId }) => {
        try {
            const state = findGame(teamCode);
            const starterIndex = state.round % state.order.length;
            const starterId = state.order[starterIndex];
            if (playerId !== starterId) {
                const starterName = state.players.get(starterId)?.name || 'the next player';
                return socket.emit('error:toast', `It's ${starterName}'s turn to start the round.`);
            }
            if (state.status === 'ended') return socket.emit('error:toast', 'Game already ended');
            if (state.status === 'guessing') return socket.emit('error:toast', 'Round in progress');
            startRound(state);
        } catch (e) {
            socket.emit('error:toast', e.message || 'Start round failed');
        }
    });

    // Police makes a guess
    socket.on('police:guess', ({ teamCode, playerId, targetId }) => {
        try {
            const state = findGame(teamCode);
            if (!state.roles) return socket.emit('error:toast', 'No active round');
            if (playerId !== state.roles.policeId) return socket.emit('error:toast', 'Only police can guess');
            if (!state.players.has(targetId)) return socket.emit('error:toast', 'Invalid target');
            endRoundWithGuess(state, playerId, targetId);
        } catch (e) {
            socket.emit('error:toast', e.message || 'Guess failed');
        }
    });

    // Disconnect handling
    socket.on('disconnect', () => {
        for (const state of games.values()) {
            for (const p of state.players.values()) {
                if (p.socketId === socket.id) {
                    p.connected = false;
                    p.socketId = null;
                    broadcastLobby(state);
                }
            }
        }
    });
});

server.listen(PORT, () => console.log(`✅ Police vs Thief server running on http://localhost:${PORT}`));