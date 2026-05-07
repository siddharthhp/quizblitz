/**
 * RetailBlitz Load Test
 * Simulates N players joining a room and answering questions.
 *
 * Usage:
 *   node loadtest.mjs --url https://your-prod-url.com --room ABCDEF --players 250
 *
 * Prerequisites (run once):
 *   npm install socket.io-client
 *
 * The host must have already uploaded a quiz and started the game before running this.
 * Players will join, then auto-answer each question randomly within 1-15s.
 */

import { io } from 'socket.io-client';
import { parseArgs } from 'util';

const { values: args } = parseArgs({
  options: {
    url:     { type: 'string',  default: 'http://localhost:3000' },
    room:    { type: 'string',  default: '' },
    players: { type: 'string',  default: '250' },
    delay:   { type: 'string',  default: '50' },  // ms between each player joining
  },
});

const URL        = args.url;
const ROOM_CODE  = args.room.toUpperCase();
const NUM_PLAYERS = parseInt(args.players, 10);
const JOIN_DELAY  = parseInt(args.delay, 10);  // stagger joins so server isn't slammed at once

if (!ROOM_CODE) {
  console.error('❌  --room is required. Example: node loadtest.mjs --room ABCDEF');
  process.exit(1);
}

console.log(`\n🚀 RetailBlitz Load Test`);
console.log(`   URL:     ${URL}`);
console.log(`   Room:    ${ROOM_CODE}`);
console.log(`   Players: ${NUM_PLAYERS}`);
console.log(`   Stagger: ${JOIN_DELAY}ms between joins\n`);

// --- Stats ---
const stats = {
  joined: 0,
  joinFailed: 0,
  answered: 0,
  errors: 0,
  latencies: [],     // answer round-trip ms
  disconnects: 0,
};

const players = [];

function spawnPlayer(index) {
  const name = `LoadBot-${String(index).padStart(4, '0')}`;
  const socket = io(URL, {
    transports: ['polling', 'websocket'],
    reconnection: false,
    timeout: 15_000,
  });

  let currentQuestion = null;
  let answerTimeout = null;

  socket.on('connect', () => {
    socket.emit('player:join', { code: ROOM_CODE, name }, (ack) => {
      if (ack?.ok) {
        stats.joined++;
        if (stats.joined % 50 === 0 || stats.joined === NUM_PLAYERS) {
          console.log(`  ✅ ${stats.joined}/${NUM_PLAYERS} joined`);
        }
      } else {
        stats.joinFailed++;
        if (stats.joinFailed <= 5) {
          console.warn(`  ⚠️  ${name} join failed: ${ack?.error}`);
        }
        socket.disconnect();
      }
    });
  });

  socket.on('question', ({ index, total, durationMs, options }) => {
    currentQuestion = { index, total, durationMs, optionCount: options.length };

    // Answer randomly between 1s and min(15s, durationMs-1s)
    const maxDelay = Math.min(15_000, durationMs - 1000);
    const delay = 1000 + Math.random() * maxDelay;
    const choice = Math.floor(Math.random() * options.length);
    const sentAt = Date.now();

    answerTimeout = setTimeout(() => {
      socket.emit('player:answer', { index, choice }, (ack) => {
        if (ack?.ok) {
          stats.answered++;
          stats.latencies.push(Date.now() - sentAt);
        } else {
          stats.errors++;
        }
      });
    }, delay);
  });

  socket.on('finished', () => {
    clearTimeout(answerTimeout);
    socket.disconnect();
  });

  socket.on('room:closed', () => {
    clearTimeout(answerTimeout);
    socket.disconnect();
  });

  socket.on('disconnect', () => {
    stats.disconnects++;
  });

  socket.on('connect_error', (err) => {
    stats.errors++;
    if (stats.errors <= 3) console.error(`  ❌ connect_error: ${err.message}`);
  });

  players.push(socket);
}

// Stagger spawning
for (let i = 1; i <= NUM_PLAYERS; i++) {
  setTimeout(() => spawnPlayer(i), i * JOIN_DELAY);
}

// Print summary every 30s and on SIGINT
function printStats() {
  const lats = stats.latencies;
  const avg = lats.length ? Math.round(lats.reduce((a, b) => a + b, 0) / lats.length) : 0;
  const max = lats.length ? Math.max(...lats) : 0;
  console.log(`\n📊 Stats @ ${new Date().toISOString()}`);
  console.log(`   Joined:       ${stats.joined}/${NUM_PLAYERS}`);
  console.log(`   Join failed:  ${stats.joinFailed}`);
  console.log(`   Answers sent: ${stats.answered}`);
  console.log(`   Errors:       ${stats.errors}`);
  console.log(`   Disconnects:  ${stats.disconnects}`);
  console.log(`   Avg latency:  ${avg}ms  Max: ${max}ms\n`);
}

const statsInterval = setInterval(printStats, 30_000);

process.on('SIGINT', () => {
  clearInterval(statsInterval);
  printStats();
  players.forEach((s) => s.disconnect());
  process.exit(0);
});

// Auto-exit 10min after all players joined (game should be done by then)
setTimeout(() => {
  clearInterval(statsInterval);
  printStats();
  players.forEach((s) => s.disconnect());
  process.exit(0);
}, NUM_PLAYERS * JOIN_DELAY + 10 * 60_000);
