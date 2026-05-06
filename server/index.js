// RetailBlitz realtime server.
// One Node process holds many "rooms" (one per host). Each room has:
//   - a 6-char join code
//   - parsed questions
//   - players { socketId -> { name, score, answers[] } }
// Scoring: faster correct answers earn more (1000 base, linear time decay).

const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { Server } = require('socket.io');

const { parseDocxBuffer } = require('./parser');

const PORT = process.env.PORT || 3000;
const DEFAULT_QUESTION_DURATION_MS = 20_000;
const MAX_PLAYERS_PER_ROOM = 500;
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LEN = 6;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
});

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 30_000,
});

const rooms = new Map();

function makeRoomCode() {
  let code;
  do {
    code = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
      code += ROOM_CODE_ALPHABET[Math.floor(Math.random() * ROOM_CODE_ALPHABET.length)];
    }
  } while (rooms.has(code));
  return code;
}

function questionDurationMs(q) {
  return (q.durationSec ?? 20) * 1000;
}

function publicQuestion(q) {
  return { id: q.id, question: q.question, options: q.options };
}

function leaderboard(room) {
  return Array.from(room.players.values())
    .map((p) => ({ name: p.name, score: p.score }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 25);
}

function broadcastRoster(room) {
  const players = Array.from(room.players.values()).map((p) => ({
    name: p.name,
    score: p.score,
  }));
  io.to(room.hostSocketId).emit('roster', { players });
}

function endQuestion(room) {
  if (room.state !== 'question') return;
  clearTimeout(room.questionTimer);
  room.questionTimer = null;
  room.state = 'reveal';

  const q = room.questions[room.currentIndex];

  for (const player of room.players.values()) {
    const ans = player.answers[room.currentIndex];
    io.to(player.socketId).emit('reveal', {
      questionId: q.id,
      correctIndex: q.correctIndex,
      yourAnswer: ans ? ans.choice : null,
      correct: !!ans?.correct,
      gained: ans?.gained ?? 0,
      score: player.score,
    });
  }

  const lb = leaderboard(room);
  io.to(room.hostSocketId).emit('reveal', {
    questionId: q.id,
    correctIndex: q.correctIndex,
    counts: q.options.map((_, idx) =>
      Array.from(room.players.values()).filter(
        (p) => p.answers[room.currentIndex]?.choice === idx,
      ).length,
    ),
    correctCount: Array.from(room.players.values()).filter(
      (p) => p.answers[room.currentIndex]?.correct,
    ).length,
    totalAnswered: Array.from(room.players.values()).filter((p) => p.answers[room.currentIndex])
      .length,
    leaderboard: lb,
  });
  // push live standings to big-screen display
  io.to(`display:${room.code}`).emit('leaderboard:update', { leaderboard: lb, final: false });
}

function startQuestion(room) {
  const q = room.questions[room.currentIndex];
  if (!q) {
    finishGame(room);
    return;
  }
  room.state = 'question';
  room.questionStart = Date.now();

  const durationMs = questionDurationMs(q);
  io.to(room.code).emit('question', {
    index: room.currentIndex,
    total: room.questions.length,
    durationMs,
    ...publicQuestion(q),
  });

  room.currentDurationMs = durationMs;
  room.questionTimer = setTimeout(() => endQuestion(room), durationMs);
}

function finishGame(room) {
  room.state = 'finished';
  const lb = leaderboard(room);
  io.to(room.code).emit('finished', { leaderboard: lb });
  // also push to big-screen display channel
  io.to(`display:${room.code}`).emit('leaderboard:update', { leaderboard: lb, final: true });
}

function nextQuestion(room) {
  if (room.state === 'question') return;
  room.currentIndex += 1;
  if (room.currentIndex >= room.questions.length) {
    finishGame(room);
  } else {
    startQuestion(room);
  }
}

// ---- HTTP: docx upload ----

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  try {
    const questions = await parseDocxBuffer(req.file.buffer);
    if (questions.length === 0) {
      return res.status(422).json({
        error:
          'Could not extract questions. Use either a table (header: Question, A, B, C, D, Answer) or prose with "Q: ..." and "A) ... ✓".',
      });
    }
    res.json({ questions });
  } catch (err) {
    console.error('upload parse error', err);
    res.status(500).json({ error: 'Failed to parse docx' });
  }
});

app.get('/health', (_req, res) => res.json({ ok: true, rooms: rooms.size }));

// ---- Socket.io ----

io.on('connection', (socket) => {
  socket.data.role = null;
  socket.data.roomCode = null;

  socket.on('host:create', ({ questions } = {}, ack) => {
    if (!Array.isArray(questions) || questions.length === 0) {
      return ack?.({ ok: false, error: 'No questions provided' });
    }
    const code = makeRoomCode();
    const room = {
      code,
      hostSocketId: socket.id,
      questions,
      players: new Map(),
      state: 'lobby',
      currentIndex: -1,
      questionStart: 0,
      questionTimer: null,
      currentDurationMs: DEFAULT_QUESTION_DURATION_MS,
    };
    rooms.set(code, room);
    socket.join(code);
    socket.data.role = 'host';
    socket.data.roomCode = code;
    ack?.({ ok: true, code, total: questions.length });
  });

  socket.on('host:start', (_payload, ack) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.hostSocketId !== socket.id) return ack?.({ ok: false, error: 'Not host' });
    if (room.state !== 'lobby') return ack?.({ ok: false, error: 'Already started' });
    if (room.players.size === 0) return ack?.({ ok: false, error: 'No players have joined' });
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

  socket.on('display:join', ({ code } = {}, ack) => {
    code = (code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    socket.join(`display:${code}`);
    socket.data.role = 'display';
    socket.data.roomCode = code;
    // send current standings immediately
    ack?.({ ok: true, leaderboard: leaderboard(room), state: room.state });
  });

  socket.on('player:join', ({ code, name } = {}, ack) => {
    code = (code || '').toUpperCase().trim();
    name = (name || '').trim().slice(0, 24);
    if (!code || !name) return ack?.({ ok: false, error: 'Code and name required' });
    const room = rooms.get(code);
    if (!room) return ack?.({ ok: false, error: 'Room not found' });
    if (room.state !== 'lobby') return ack?.({ ok: false, error: 'Game already started' });
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) return ack?.({ ok: false, error: 'Room full' });
    if (
      Array.from(room.players.values()).some((p) => p.name.toLowerCase() === name.toLowerCase())
    )
      return ack?.({ ok: false, error: 'Name already taken' });

    room.players.set(socket.id, {
      socketId: socket.id,
      name,
      score: 0,
      answers: [],
    });
    socket.join(code);
    socket.data.role = 'player';
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

    const q = room.questions[index];
    const elapsed = Date.now() - room.questionStart;
    const correct = choice === q.correctIndex;
    const durationMs = room.currentDurationMs || DEFAULT_QUESTION_DURATION_MS;
    const gained = correct
      ? Math.max(500, Math.round(1000 - (500 * elapsed) / durationMs))
      : 0;

    player.answers[index] = { choice, correct, gained, elapsedMs: elapsed };
    player.score += gained;

    ack?.({ ok: true, locked: true });

    io.to(room.hostSocketId).emit('answer:tick', {
      answered: Array.from(room.players.values()).filter((p) => p.answers[index]).length,
      total: room.players.size,
    });

    if (Array.from(room.players.values()).every((p) => p.answers[index])) {
      endQuestion(room);
    }
  });

  socket.on('disconnect', () => {
    const code = socket.data.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;

    if (socket.id === room.hostSocketId) {
      io.to(code).emit('room:closed', { reason: 'Host disconnected' });
      if (room.questionTimer) clearTimeout(room.questionTimer);
      rooms.delete(code);
      return;
    }

    if (room.players.delete(socket.id)) {
      broadcastRoster(room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`RetailBlitz listening on :${PORT}`);
});
