(() => {
  const $ = (id) => document.getElementById(id);
  const show = (stepId) => {
    document.querySelectorAll('main > section').forEach((s) => s.classList.add('hidden'));
    $(stepId).classList.remove('hidden');
  };

  const code = (sessionStorage.getItem('qb:code') || '').toUpperCase();
  const name = sessionStorage.getItem('qb:name') || '';
  const avatar = sessionStorage.getItem('qb:avatar') || '🎯';
  if (!code || !name) { location.href = '/'; return; }

  $('meName').textContent = `${avatar} ${name}`;
  if ($('waitingCode')) $('waitingCode').textContent = code;

  const HISTORY_KEY = 'qb:history';
  const history = loadHistory();
  const currentRoom = code;

  const socket = io();
  let countdownTimer = null;
  let currentIndex = -1;
  let lockedChoice = null;
  let myScore = 0;

  // ---- Audio ----
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  let audioCtx = null;

  function getAudioCtx() {
    if (!audioCtx) {
      try { audioCtx = new AudioCtx(); } catch { return null; }
    }
    return audioCtx;
  }

  function playTone(freq, type, duration, gainVal) {
    const ctx = getAudioCtx();
    if (!ctx) return;
    try {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = type;
      osc.frequency.setValueAtTime(freq, ctx.currentTime);
      gain.gain.setValueAtTime(gainVal, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.start(ctx.currentTime);
      osc.stop(ctx.currentTime + duration);
    } catch { /* audio unavailable */ }
  }

  function soundLock() {
    // Short satisfying click-thunk
    playTone(440, 'sine', 0.08, 0.4);
    setTimeout(() => playTone(600, 'sine', 0.1, 0.25), 60);
  }

  function soundCorrect() {
    // Ascending fanfare: C-E-G
    playTone(523, 'sine', 0.15, 0.4);
    setTimeout(() => playTone(659, 'sine', 0.15, 0.4), 120);
    setTimeout(() => playTone(784, 'sine', 0.25, 0.45), 240);
  }

  function soundWrong() {
    // Low descending buzz
    playTone(300, 'sawtooth', 0.12, 0.25);
    setTimeout(() => playTone(220, 'sawtooth', 0.18, 0.2), 100);
  }

  function soundTick() {
    // Quiet tick for last 3 seconds
    playTone(880, 'square', 0.06, 0.15);
  }

  // ---- Confetti ----
  function fireConfetti() {
    if (typeof confetti !== 'function') return;
    confetti({
      particleCount: 120,
      spread: 80,
      origin: { y: 0.55 },
      colors: ['#ffd166', '#06d6a0', '#c77dff', '#ef476f', '#118ab2'],
    });
    // Second burst slightly offset
    setTimeout(() => confetti({
      particleCount: 60,
      spread: 50,
      angle: 60,
      origin: { x: 0.1, y: 0.6 },
    }), 200);
    setTimeout(() => confetti({
      particleCount: 60,
      spread: 50,
      angle: 120,
      origin: { x: 0.9, y: 0.6 },
    }), 350);
  }

  // ---- Connect & join ----
  socket.on('connect', () => {
    $('waitingMsg').textContent = 'Joining room…';
    $('waitingMsg').className = 'msg';
    socket.emit('player:join', { code, name, avatar }, (ack) => {
      if (!ack?.ok) {
        const err = ack?.error || 'Could not join room';
        // Store error and redirect back to join page — code + name will be pre-filled
        sessionStorage.setItem('qb:joinError', err);
        location.href = '/';
        return;
      }
      show('step-lobby');
    });
  });

  // Show live player count in lobby
  socket.on('roster', ({ players }) => {
    const el = $('lobbyCount');
    if (el) el.textContent = players.length;
  });

  // Reconnect handling — show overlay, attempt rejoin
  socket.on('disconnect', () => {
    const s = $('qStatus');
    if (s) {
      s.innerHTML = `<span class="diff-label" style="color:#c62828;background:rgba(239,71,111,0.15);">⚡ Reconnecting…</span>`;
      s.style.background = '';
    }
    stopCountdown();
  });

  socket.on('reconnect', () => {
    const s = $('qStatus');
    if (s) { s.innerHTML = ''; s.style.background = ''; }
    // Re-join the room after reconnect so server re-registers the socket
    socket.emit('player:join', { code, name, avatar }, (ack) => {
      if (!ack?.ok) {
        if ($('waitingMsg')) {
          $('waitingMsg').textContent = ack?.error || 'Could not rejoin';
          $('waitingMsg').className = 'msg error';
        }
        show('step-waiting');
      }
      // Server will emit current game state event (question/reveal/finished) which will re-sync UI
    });
  });

  // ---- Delegate clicks on options ----
  $('qOptions').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-idx]');
    if (!li) return;
    // Unlock AudioContext on first user gesture (required by browsers)
    if (audioCtx?.state === 'suspended') audioCtx.resume();
    choose(parseInt(li.dataset.idx, 10), li);
  });

  // ---- Pre-game countdown ----
  let playerOverlayTimer = null;
  socket.on('pre-question', ({ seconds }) => {
    let overlay = $('playerCountdownOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'playerCountdownOverlay';
      overlay.style.cssText = [
        'position:fixed;inset:0;z-index:999',
        'display:flex;flex-direction:column;align-items:center;justify-content:center',
        'background:rgba(4,30,66,0.92)',
        'color:#fff',
        'font-family:inherit',
        'pointer-events:none',
      ].join(';');
      overlay.innerHTML = `
        <div style="font-size:18px;font-weight:700;letter-spacing:0.05em;margin-bottom:12px;opacity:0.85;">GET READY!</div>
        <div id="playerOverlayCount" style="font-size:100px;font-weight:900;line-height:1;color:#ffc220;text-shadow:0 0 40px rgba(255,194,32,0.6);"></div>
      `;
      document.body.appendChild(overlay);
    }
    if (playerOverlayTimer) clearInterval(playerOverlayTimer);
    let s = seconds;
    const countEl = overlay.querySelector('#playerOverlayCount');
    overlay.style.display = 'flex';
    countEl.textContent = s;
    playerOverlayTimer = setInterval(() => {
      s -= 1;
      if (s <= 0) {
        clearInterval(playerOverlayTimer);
        playerOverlayTimer = null;
        overlay.style.display = 'none';
        return;
      }
      countEl.textContent = s;
      countEl.style.transform = 'scale(1.3)';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        countEl.style.transition = 'transform 0.4s cubic-bezier(0.34,1.56,0.64,1)';
        countEl.style.transform = 'scale(1)';
      }));
    }, 1000);
  });

  // ---- Question received ----
  const DIFF_STYLE = {
    'very easy': { bg: 'rgba(46,125,50,0.15)',  color: '#2e7d32', label: '⭐ Very Easy' },
    'easy':      { bg: 'rgba(46,125,50,0.15)',  color: '#2e7d32', label: '⭐⭐ Easy' },
    'medium':    { bg: 'rgba(230,81,0,0.15)',   color: '#e65100', label: '⭐⭐⭐ Medium' },
    'hard':      { bg: 'rgba(198,40,40,0.15)',  color: '#c62828', label: '⭐⭐⭐⭐ Hard' },
  };

  socket.on('question', ({ index, total, durationMs, question, options, difficulty, maxPts }) => {
    currentIndex = index;
    lockedChoice = null;
    $('qIndex').textContent = `Q ${index + 1} / ${total}`;
    $('qText').textContent = question;

    const list = $('qOptions');
    list.innerHTML = '';
    list.classList.remove('answered');
    options.forEach((text, i) => {
      const li = document.createElement('li');
      li.dataset.letter = String.fromCharCode(65 + i);
      li.dataset.idx = String(i);
      li.innerHTML = `<span class="letter">${li.dataset.letter}</span><span>${escapeHtml(text)}</span>`;
      list.appendChild(li);
    });

    const status = $('qStatus');
    const ds = DIFF_STYLE[difficulty] || DIFF_STYLE['hard'];
    status.innerHTML = `<span class="diff-label" style="color:${ds.color};background:${ds.bg};">${ds.label}</span><span class="diff-pts" style="color:var(--accent);">${maxPts ?? '?'} pts</span>`;
    status.style.background = '';
    show('step-question');
    startCountdown(Math.round(durationMs / 1000));
  });

  function choose(idx, node) {
    if (lockedChoice !== null) return;
    lockedChoice = idx;
    Array.from($('qOptions').children).forEach((n) => {
      if (n !== node) n.classList.add('disabled');
    });
    node.classList.add('locked');
    soundLock();

    const status = $('qStatus');
    status.innerHTML = `<span class="diff-label" style="color:#7a5a00;background:rgba(255,209,102,0.3);">⏳ Locked in</span>`;
    status.style.background = '';

    socket.emit('player:answer', { index: currentIndex, choice: idx }, (ack) => {
      if (!ack?.ok) {
        status.innerHTML = `<span class="diff-label" style="color:#c62828;background:rgba(239,71,111,0.15);">⚠️ ${ack?.error || 'Try again'}</span>`;
        status.style.background = '';
        lockedChoice = null;
        node.classList.remove('locked');
        Array.from($('qOptions').children).forEach((n) =>
          n.classList.remove('disabled', 'locked'),
        );
      }
    });
  }

  // ---- Reveal ----
  socket.on('reveal', (data) => {
    if ('counts' in data) return; // host-shaped, skip
    stopCountdown();
    myScore = data.score;
    $('meScore').textContent = data.score;

    const optNodes = $('qOptions').children;
    const correctText = optNodes[data.correctIndex]?.children[1]?.textContent ?? '?';
    const yourText =
      data.yourAnswer == null
        ? '(no answer)'
        : optNodes[data.yourAnswer]?.children[1]?.textContent ?? '?';

    if (data.correct) {
      const bonus = data.bonus || 0;
      let streakMsg = '';
      if (bonus > 0) {
        const streakLabel = data.streak >= 5 ? '🔥🔥 5-streak!' : '🔥 3-streak!';
        streakMsg = ` <span style="color:var(--accent);font-size:14px;">${streakLabel} +${bonus} bonus</span>`;
      }
      $('revealHeadline').innerHTML = `<span class="banner ok">✓ CORRECT</span>`;
      $('revealPoints').innerHTML = `<span style="color:var(--good);">+${data.gained} pts</span>${streakMsg}`;
      soundCorrect();
      fireConfetti();
    } else {
      $('revealHeadline').innerHTML = `<span class="banner err">✗ WRONG</span>`;
      $('revealPoints').innerHTML = data.yourAnswer == null
        ? `<span style="color:var(--muted);">No answer — 0 pts</span>`
        : `<span style="color:var(--bad);">+0 pts</span>`;
      soundWrong();
    }
    $('revealDetail').textContent = `Correct answer: "${correctText}".${data.yourAnswer != null && !data.correct ? ` You chose: "${yourText}".` : ''}`;

    // Fastest answer callout
    const fastestEl = $('revealFastest');
    if (fastestEl) {
      if (data.fastest) {
        const secs = (data.fastest.ms / 1000).toFixed(1);
        const isMe = data.fastest.name === name;
        fastestEl.innerHTML = isMe
          ? `⚡ <strong>You</strong> were the fastest! (${secs}s)`
          : `⚡ Fastest: <strong>${escapeHtml(data.fastest.name)}</strong> (${secs}s)`;
        fastestEl.classList.remove('hidden');
      } else {
        fastestEl.classList.add('hidden');
      }
    }
    $('revealScore').textContent = data.score;

    history.push({
      ts: Date.now(),
      room: currentRoom,
      questionId: data.questionId,
      yourAnswer: data.yourAnswer,
      correct: data.correct,
      gained: data.gained,
      score: data.score,
    });
    saveHistory(history);

    show('step-reveal');
  });

  // ---- Game over ----
  socket.on('finished', ({ leaderboard, rank, total }) => {
    stopCountdown();
    $('finalScore').textContent = myScore;

    // Show personal rank banner
    const rankBanner = document.getElementById('myRankBanner');
    if (rankBanner && rank) {
      const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : '🎯';
      rankBanner.innerHTML = `${medal} You finished <strong>#${rank}</strong> out of <strong>${total}</strong> players!`;
      rankBanner.classList.remove('hidden');
    }

    const lb = $('finalBoard');
    lb.innerHTML = '';
    let myRank = rank || -1;
    leaderboard.forEach((p, i) => {
      const li = document.createElement('li');
      const isMe = p.name === name;
      const av = p.avatar ? `<span class="lb-avatar">${p.avatar}</span>` : '';
      li.innerHTML = `${av}<span class="lb-name">${escapeHtml(p.name)}${isMe ? ' 👈 you' : ''}</span><span class="lb-score">${p.score}</span>`;
      lb.appendChild(li);
    });

    // Celebrate top 3 finish
    if (myRank >= 1 && myRank <= 3) {
      setTimeout(fireConfetti, 300);
      setTimeout(fireConfetti, 900);
    }

    const roomHistory = history.filter((h) => h.room === currentRoom);
    const hist = $('history');
    hist.innerHTML = '';
    roomHistory.forEach((h, idx) => {
      const li = document.createElement('li');
      li.className = h.correct ? 'ok' : 'err';
      li.textContent = `Q${idx + 1}: ${h.correct ? '✓ correct' : '✗ wrong'} (+${h.gained} pts)`;
      hist.appendChild(li);
    });

    show('step-finished');
  });

  socket.on('room:closed', ({ reason }) => {
    stopCountdown();
    $('waitingMsg').textContent = reason || 'Room closed by host';
    $('waitingMsg').className = 'msg error';
    show('step-waiting');
  });

  // ---- Countdown ----
  function startCountdown(seconds) {
    stopCountdown();
    let s = seconds;
    const el = $('qTimer');
    el.textContent = s;
    el.classList.remove('warning', 'critical');
    countdownTimer = setInterval(() => {
      s = Math.max(0, s - 1);
      el.textContent = s;
      el.classList.remove('warning', 'critical');
      if (s <= 3 && s > 0) {
        el.classList.add('critical');
        soundTick();
      } else if (s <= 10) {
        el.classList.add('warning');
      }
      if (s === 0) stopCountdown();
    }, 1000);
  }

  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    const el = $('qTimer');
    if (el) el.classList.remove('warning', 'critical');
  }

  // ---- Helpers ----
  function loadHistory() {
    try { return JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]'); } catch { return []; }
  }
  function saveHistory(h) {
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h.slice(-500))); } catch { /* quota */ }
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }
})();
