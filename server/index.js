// BrainBlitz realtime server.
// One Node process holds many "rooms" (one per host). Each room has:
//   - a 6-char join code
//   - parsed questions
//   - players { socketId -> { name, score, answers[] } }
// Scoring: fixed 100 pts per correct answer + streak bonuses (+200 at 3-streak, +500 at 5-streak).

const path   = require('path');
const fs     = require('fs');
const crypto = require('crypto');
const http   = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');

const { parseDocxBuffer } = require('./parser');

// Copy CDN-sourced browser bundles to public/js at startup.
// This ensures QR codes and confetti work even on networks that block CDNs.
const BUNDLE_COPIES = [
  { src: 'qrcode/build/qrcode.min.js',                    dst: 'qrcode.min.js' },
  { src: 'canvas-confetti/dist/confetti.browser.min.js',  dst: 'confetti.browser.min.js' },
];
for (const { src, dst } of BUNDLE_COPIES) {
  try {
    const srcPath = require.resolve(src);
    const dstPath = path.join(__dirname, '..', 'public', 'js', dst);
    if (!fs.existsSync(dstPath) ||
        fs.statSync(srcPath).mtimeMs > fs.statSync(dstPath).mtimeMs) {
      fs.copyFileSync(srcPath, dstPath);
      console.log(`Bundled ${dst} → public/js/`);
    }
  } catch (e) {
    console.warn(`Could not bundle ${dst}:`, e.message);
  }
}

const PORT = process.env.PORT || 3000;
const DEFAULT_QUESTION_DURATION_MS = 20_000;

const DIFFICULTY_TIERS = [
  { maxMs:  8_000, label: 'very easy' },
  { maxMs: 12_000, label: 'easy'      },
  { maxMs: 15_000, label: 'medium'    },
  { maxMs: 18_000, label: 'hard'      },
];

const POINTS_PER_QUESTION   = 100;
const MAX_PLAYERS_PER_ROOM  = 500;
const AVATAR_ALLOWLIST = ['🦁','🐯','🐻','🦊','🐼','🐨','🐸','🐙','🦋','🦄','🐬','🦅','🐲','🦖','🌟','🔥'];
const DEFAULT_AVATAR   = '🎯';

// Lobby rooms expire after 20 min of inactivity.
// Teaser rooms (scheduled games) last 7 days from creation.
const HOST_RECONNECT_GRACE_MS = 20 * 60 * 1000;       // 20 minutes
const TEASER_ROOM_TTL_MS      = 7 * 24 * 60 * 60 * 1000; // 7 days

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LEN      = 6;

// ---- Persistence ----
// Teaser rooms must survive server restarts (the link is shared days in advance).
// We persist them to a JSON file and reload on boot.
const PERSIST_PATH = path.join(__dirname, 'rooms.json');

function sanitizeAvatar(a) {
  return AVATAR_ALLOWLIST.includes(a) ? a : DEFAULT_AVATAR;
}

function maxPointsForDuration(_ms) { return POINTS_PER_QUESTION; }

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' }, pingTimeout: 30_000 });

// rooms: code -> room object (runtime, includes Map + timers)
const rooms = new Map();

// ---- Room persistence helpers ----

function serializeRoom(room) {
  return {
    code:      room.code,
    hostToken: room.hostToken,
    questions: room.questions,
    state:     room.state,
    expiresAt: room.expiresAt,
    teaser:    room.teaser || null,
  };
}

function saveTeaserRooms() {
  const toSave = [];
  for (const room of rooms.values()) {
    if (room.state === 'teaser') toSave.push(serializeRoom(room));
  }
  try {
    fs.writeFileSync(PERSIST_PATH, JSON.stringify(toSave, null, 2));
  } catch (e) {
    console.error('Failed to persist rooms:', e.message);
  }
}

function loadPersistedRooms() {
  if (!fs.existsSync(PERSIST_PATH)) return;
  try {
    const data = JSON.parse(fs.readFileSync(PERSIST_PATH, 'utf8'));
    const now = Date.now();
    for (const r of data) {
      if (r.expiresAt && r.expiresAt < now) continue; // expired
      if (r.state !== 'teaser') continue;
      const room = makeRoomObject(r.code, r.questions, null, r.hostToken);
      room.state     = 'teaser';
      room.teaser    = r.teaser || null;
      room.expiresAt = r.expiresAt;
      // Schedule cleanup at expiry
      const remaining = r.expiresAt - now;
      room.cleanupTimer = scheduleRoomCleanup(r.code, remaining);
      rooms.set(r.code, room);
      console.log(`Restored teaser room ${r.code} (expires in ${Math.round(remaining/3600000)}h)`);
    }
  } catch (e) {
    console.error('Failed to load persisted rooms:', e.message);
  }
}

// ---- Room factory ----

function makeRoomCode() {
  let code;
  do {
    // Use cryptographically secure random bytes — unguessable even for
    // 7-day teaser links that are the sole gate on a room.
    const bytes = crypto.randomBytes(ROOM_CODE_LEN);
    code = Array.from(bytes)
      .map((b) => ROOM_CODE_ALPHABET[b % ROOM_CODE_ALPHABET.length])
      .join('');
  } while (rooms.has(code));
  return code;
}

function makeRoomObject(code, questions, hostSocketId, hostToken) {
  return {
    code,
    hostSocketId,
    hostToken,
    questions,
    players:          new Map(),
    state:            'lobby',
    currentIndex:     -1,
    questionStart:    0,
    questionTimer:    null,
    currentDurationMs: DEFAULT_QUESTION_DURATION_MS,
    fastestPerQ:      [],
    cleanupTimer:     null,
    expiresAt:        null,
    teaser:           null,
  };
}

function generateHostToken() {
  // 32 cryptographically-random hex chars (128-bit entropy)
  return crypto.randomBytes(16).toString('hex');
}

// Validate parsed question array — rejects malformed uploads
function validateQuestions(questions) {
  if (!Array.isArray(questions) || questions.length === 0) return 'No questions provided';
  for (let i = 0; i < questions.length; i++) {
    const q = questions[i];
    if (typeof q.question !== 'string' || !q.question.trim()) return `Question ${i + 1} has empty text`;
    if (!Array.isArray(q.options) || q.options.length < 2) return `Question ${i + 1} needs at least 2 options`;
    if (typeof q.correctIndex !== 'number' || q.correctIndex < 0 || q.correctIndex >= q.options.length)
      return `Question ${i + 1} has invalid correctIndex`;
  }
  return null; // valid
}

// ---- Cleanup ----

function scheduleRoomCleanup(code, delayMs) {
  return setTimeout(() => {
    const room = rooms.get(code);
    if (!room) return;
    if (room.state === 'lobby' || room.state === 'teaser') {
      io.to(code).emit('room:closed', { reason: 'Game session expired' });
      io.to(`teaser:${code}`).emit('room:closed', { reason: 'Game session expired' });
      if (room.questionTimer) clearTimeout(room.questionTimer);
      rooms.delete(code);
      saveTeaserRooms();
      console.log(`Room ${code} expired`);
    }
  }, delayMs);
}

// ---- Game logic ----

function questionDurationMs(q) { return (q.durationSec ?? 20) * 1000; }

function difficultyLabel(ms) {
  const tier = DIFFICULTY_TIERS.find((t) => t.maxMs === ms);
  return tier ? tier.label : 'hard';
}

function publicQuestion(q, ms) {
  return { id: q.id, question: q.question, options: q.options, difficulty: difficultyLabel(ms), maxPts: maxPointsForDuration(ms) };
}

function leaderboard(room, limit = 25) {
  return Array.from(room.players.values())
    .map((p) => ({ name: p.name, score: p.score, avatar: p.avatar }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function fullLeaderboard(room) {
  return Array.from(room.players.values())
    .map((p) => ({ name: p.name, score: p.score, avatar: p.avatar }))
    .sort((a, b) => b.score - a.score);
}

function broadcastRoster(room) {
  const players = Array.from(room.players.values()).map((p) => ({ name: p.name, score: p.score, avatar: p.avatar }));
  io.to(room.code).emit('roster', { players });
  io.to(`display:${room.code}`).emit('roster', { players });
}

function endQuestion(room) {
  if (room.state !== 'question') return;
  clearTimeout(room.questionTimer);
  room.questionTimer = null;
  room.state = 'reveal';

  const q   = room.questions[room.currentIndex];
  const idx = room.currentIndex;

  for (const player of room.players.values()) {
    if (!player.answers[idx]) player.streak = 0;
  }

  const fastest = room.fastestPerQ[idx] || null;
  for (const player of room.players.values()) {
    const ans = player.answers[idx];
    io.to(player.socketId).emit('reveal', {
      questionId: q.id, correctIndex: q.correctIndex,
      yourAnswer: ans ? ans.choice : null, correct: !!ans?.correct,
      gained: ans?.gained ?? 0, bonus: ans?.bonus ?? 0,
      streak: player.streak, score: player.score, fastest,
    });
  }

  const counts = q.options.map((_, i) =>
    Array.from(room.players.values()).filter((p) => p.answers[idx]?.choice === i).length,
  );
  const correctCount   = Array.from(room.players.values()).filter((p) => p.answers[idx]?.correct).length;
  const totalAnswered  = Array.from(room.players.values()).filter((p) => p.answers[idx]).length;
  const lb             = leaderboard(room);

  io.to(room.hostSocketId).emit('reveal', {
    questionId: q.id, correctIndex: q.correctIndex, counts, correctCount, totalAnswered, leaderboard: lb, fastest,
  });
  io.to(`display:${room.code}`).emit('leaderboard:update', { leaderboard: lb, final: false });
  io.to(`display:${room.code}`).emit('reveal:stats', { counts, correctIndex: q.correctIndex, options: q.options, fastest, totalAnswered });
}

function startQuestion(room) {
  const q = room.questions[room.currentIndex];
  if (!q) { finishGame(room); return; }
  room.state        = 'question';
  room.questionStart = Date.now();
  const durationMs  = questionDurationMs(q);
  io.to(room.code).emit('question', { index: room.currentIndex, total: room.questions.length, durationMs, ...publicQuestion(q, durationMs) });
  room.currentDurationMs = durationMs;
  room.questionTimer     = setTimeout(() => endQuestion(room), durationMs);
}

function finishGame(room) {
  room.state    = 'finished';
  const lb      = leaderboard(room);
  const allLb   = fullLeaderboard(room);
  for (const player of room.players.values()) {
    const rank = allLb.findIndex((p) => p.name === player.name) + 1;
    io.to(player.socketId).emit('finished', { leaderboard: lb, rank, total: allLb.length });
  }
  io.to(room.hostSocketId).emit('finished', { leaderboard: lb });
  io.to(`display:${room.code}`).emit('leaderboard:update', { leaderboard: allLb, final: true });
}

function nextQuestion(room) {
  if (room.state === 'question') return;
  room.currentIndex += 1;
  if (room.currentIndex >= room.questions.length) finishGame(room);
  else startQuestion(room);
}

// ---- HTTP ----

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const questions = await parseDocxBuffer(req.file.buffer);
    if (questions.length === 0)
      return res.status(422).json({ error: 'Could not extract questions. Use either a table or prose format.' });
    res.json({ questions });
  } catch (err) {
    console.error('upload parse error', err);
    res.status(500).json({ error: 'Failed to parse docx' });
  }
});

// Public room state — teaser page polls/checks this to know when to flip to join
app.get('/api/room/:code', (req, res) => {
  const code = (req.params.code || '').toUpperCase().trim();
  const room = rooms.get(code);
  if (!room) return res.status(404).json({ ok: false, error: 'Room not found' });
  res.json({
    ok:       true,
    state:    room.state,
    teaser:   room.teaser || null,
    expiresAt: room.expiresAt || null,
  });
});

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ---- Socket.io ----

io.on('connection', (socket) => {
  socket.data.role     = null;
  socket.data.roomCode = null;

  // Create a normal immediate lobby room
  socket.on('host:create', ({ questions } = {}, ack) => {
    const err = validateQuestions(questions);
    if (err) return ack?.({ ok: false, error: err });

    const code      = makeRoomCode();
    const hostToken = generateHostToken();
    const room      = makeRoomObject(code, questions, socket.id, hostToken);
    room.expiresAt  = Date.now() + HOST_RECONNECT_GRACE_MS;
    room.cleanupTimer = scheduleRoomCleanup(code, HOST_RECONNECT_GRACE_MS);
    rooms.set(code, room);
    socket.join(code);
    socket.data.role     = 'host';
    socket.data.roomCode = code;
    ack?.({ ok: true, code, hostToken, total: questions.length });
  });

  // Schedule a room — teaser state, long TTL, link shareable immediately
  socket.on('host:schedule', ({ questions, teaser } = {}, ack) => {
    const err = validateQuestions(questions);
    if (err) return ack?.({ ok: false, error: err });

    const code      = makeRoomCode();
    const hostToken = generateHostToken();
    const room      = makeRoomObject(code, questions, socket.id, hostToken);
    room.state      = 'teaser';
    room.expiresAt  = Date.now() + TEASER_ROOM_TTL_MS;
    room.teaser     = teaser || null; // { goLiveAt: ISO string, title, hint1, hint2 }
    room.cleanupTimer = scheduleRoomCleanup(code, TEASER_ROOM_TTL_MS);
    rooms.set(code, room);
    socket.join(code);
    socket.data.role     = 'host';
    socket.data.roomCode = code;
    saveTeaserRooms();
    ack?.({ ok: true, code, hostToken, total: questions.length });
  });

  // Host reclaims a teaser room on a new session (Friday) using their token
  socket.on('host:resume', ({ code, hostToken } = {}, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    if (room.hostToken !== hostToken) return ack?.({ ok: false, error: 'Invalid token' });
    room.hostSocketId = socket.id;
    socket.join(code);
    socket.data.role     = 'host';
    socket.data.roomCode = code;
    ack?.({ ok: true, state: room.state, total: room.questions.length, code });
  });

  socket.on('host:start', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    if (room.hostSocketId === null && socket.data.role === 'host') room.hostSocketId = socket.id;
    if (room.hostSocketId !== socket.id) return ack?.({ ok: false, error: 'Not host' });

    if (room.state === 'teaser') {
      // Flip teaser → lobby, notify all waiting teaser watchers
      room.state = 'lobby';
      io.to(`teaser:${room.code}`).emit('teaser:golive', { code: room.code });
      saveTeaserRooms();
      ack?.({ ok: true, teaser: true }); // host.js shows "waiting for players to join"
      return;
    }

    if (room.state !== 'lobby') return ack?.({ ok: false, error: 'Already started' });
    if (room.players.size === 0) return ack?.({ ok: false, error: 'No players have joined' });
    if (room.cleanupTimer) { clearTimeout(room.cleanupTimer); room.cleanupTimer = null; }
    room.currentIndex = 0;
    startQuestion(room);
    ack?.({ ok: true });
  });

  socket.on('host:next', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return ack?.({ ok: false, error: 'Not host' });
    nextQuestion(room);
    ack?.({ ok: true });
  });

  socket.on('host:skip', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return ack?.({ ok: false, error: 'Not host' });
    if (room.state === 'question') endQuestion(room);
    ack?.({ ok: true });
  });

  socket.on('host:end', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return ack?.({ ok: false, error: 'Not host' });
    if (room.state === 'finished') return ack?.({ ok: true });
    if (room.questionTimer) { clearTimeout(room.questionTimer); room.questionTimer = null; }
    finishGame(room);
    ack?.({ ok: true });
  });

  // Teaser watchers — browser subscribes to go-live push via this channel
  socket.on('teaser:watch', ({ code } = {}, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    socket.join(`teaser:${code}`);
    ack?.({ ok: true, state: room.state, teaser: room.teaser || null });
  });

  socket.on('display:join', ({ code } = {}, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    socket.join(`display:${code}`);
    socket.data.role     = 'display';
    socket.data.roomCode = code;
    const players = Array.from(room.players.values()).map((p) => ({ name: p.name, score: p.score, avatar: p.avatar }));
    ack?.({ ok: true, leaderboard: leaderboard(room), state: room.state, players, currentIndex: room.currentIndex });
  });

  socket.on('player:join', ({ code, name, avatar } = {}, ack) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim().slice(0, 24);
    if (!code || !name) return ack?.({ ok: false, error: 'Code and name required' });
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    if (room.state === 'teaser') return ack?.({ ok: false, error: 'teaser' }); // signal to redirect
    if (room.state !== 'lobby') return ack?.({ ok: false, error: 'Game already started' });
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) return ack?.({ ok: false, error: 'Room full' });
    if (Array.from(room.players.values()).some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return ack?.({ ok: false, error: `"${name}" is already taken — try a different name (e.g. add your last initial)` });

    room.players.set(socket.id, {
      socketId: socket.id, name, avatar: sanitizeAvatar(avatar),
      score: 0, answers: [], streak: 0, maxStreak: 0,
    });
    socket.join(code);
    socket.data.role     = 'player';
    socket.data.roomCode = code;
    broadcastRoster(room);
    ack?.({ ok: true, name, total: room.questions.length });
  });

  socket.on('player:answer', ({ index, choice } = {}, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.state !== 'question') return ack?.({ ok: false, error: 'No active question' });
    if (index !== room.currentIndex) return ack?.({ ok: false, error: 'Stale answer' });
    const player = room.players.get(socket.id);
    if (!player) return ack?.({ ok: false, error: 'Not in room' });
    if (player.answers[index]) return ack?.({ ok: false, error: 'Already answered' });
    // Validate choice is a non-negative integer within the options range
    const q = room.questions[index];
    if (typeof choice !== 'number' || !Number.isInteger(choice) || choice < 0 || choice >= q.options.length)
      return ack?.({ ok: false, error: 'Invalid choice' });

    const elapsed = Date.now() - room.questionStart;
    const correct = choice === q.correctIndex;
    const gained  = correct ? POINTS_PER_QUESTION : 0;

    let bonus = 0;
    if (correct) {
      player.streak += 1;
      if (player.streak > player.maxStreak) player.maxStreak = player.streak;
      if (player.streak === 3) bonus = 200;
      else if (player.streak === 5) bonus = 500;
    } else {
      player.streak = 0;
    }

    if (correct) {
      const existing = room.fastestPerQ[index];
      if (!existing || elapsed < existing.ms) room.fastestPerQ[index] = { name: player.name, ms: elapsed };
    }

    player.answers[index] = { choice, correct, gained, bonus, elapsedMs: elapsed };
    player.score += gained + bonus;
    ack?.({ ok: true, locked: true });

    io.to(room.hostSocketId).emit('answer:tick', {
      answered: Array.from(room.players.values()).filter((p) => p.answers[index]).length,
      total: room.players.size,
    });

    if (Array.from(room.players.values()).every((p) => p.answers[index])) endQuestion(room);
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.id === room.hostSocketId) {
      if (room.state === 'finished') return;

      if (room.state === 'teaser') {
        // Teaser rooms are persisted — just mark host absent, keep the room
        room.hostSocketId = null;
        saveTeaserRooms();
        return;
      }

      if (room.state === 'lobby') {
        console.log(`Host disconnected from lobby ${code} — grace period started`);
        room.hostSocketId = null;
        if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
        room.cleanupTimer = scheduleRoomCleanup(code, HOST_RECONNECT_GRACE_MS);
        return;
      }

      // Game in progress — close immediately
      io.to(code).emit('room:closed', { reason: 'Host disconnected' });
      if (room.questionTimer) clearTimeout(room.questionTimer);
      if (room.cleanupTimer) clearTimeout(room.cleanupTimer);
      rooms.delete(code);
      return;
    }

    if (room.players.delete(socket.id)) broadcastRoster(room);
  });
});

// Load any persisted teaser rooms before accepting connections
loadPersistedRooms();

server.listen(PORT, () => {
  console.log(`BrainBlitz listening on :${PORT}`);
});
