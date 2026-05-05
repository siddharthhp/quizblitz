(() => {
  const $ = (id) => document.getElementById(id);
  const show = (stepId) => {
    document.querySelectorAll('main > section').forEach((s) => s.classList.add('hidden'));
    $(stepId).classList.remove('hidden');
  };

  const code = (sessionStorage.getItem('qb:code') || '').toUpperCase();
  const name = sessionStorage.getItem('qb:name') || '';
  if (!code || !name) { location.href = '/'; return; }

  $('meName').textContent = name;
  if ($('waitingCode')) $('waitingCode').textContent = code;

  const HISTORY_KEY = 'qb:history';
  const history = loadHistory();
  const currentRoom = code;

  const socket = io();
  let countdownTimer = null;
  let currentIndex = -1;
  let lockedChoice = null;
  let myScore = 0;

  // Connect & join
  socket.on('connect', () => {
    $('waitingMsg').textContent = 'Joining room…';
    $('waitingMsg').className = 'msg';
    socket.emit('player:join', { code, name }, (ack) => {
      if (!ack?.ok) {
        const err = ack?.error || 'Could not join room';
        $('waitingMsg').innerHTML =
          `❌ <strong>${err}</strong><br><br>` +
          `<a class="ghost" href="/" style="display:inline-block;margin-top:8px;">← Try again</a>`;
        $('waitingMsg').className = 'msg error';
        return;
      }
      show('step-lobby');
    });
  });

  // Delegate clicks on the options list — works even when clicking child <span>
  $('qOptions').addEventListener('click', (e) => {
    const li = e.target.closest('li[data-idx]');
    if (!li) return;
    choose(parseInt(li.dataset.idx, 10), li);
  });

  // Question received
  socket.on('question', ({ index, total, durationMs, question, options }) => {
    currentIndex = index;
    lockedChoice = null;
    $('qIndex').textContent = `Q ${index + 1} / ${total}`;
    $('qText').textContent = question;

    const list = $('qOptions');
    list.innerHTML = '';
    // Remove any leftover disabled state from previous question
    list.classList.remove('answered');
    options.forEach((text, i) => {
      const li = document.createElement('li');
      li.dataset.letter = String.fromCharCode(65 + i);
      li.dataset.idx = String(i);
      li.innerHTML = `<span class="letter">${li.dataset.letter}</span><span>${escapeHtml(text)}</span>`;
      list.appendChild(li);
    });

    const status = $('qStatus');
    status.textContent = '';
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

    const status = $('qStatus');
    status.textContent = '⏳ Locked in';
    status.style.background = 'rgba(255,209,102,0.25)';

    socket.emit('player:answer', { index: currentIndex, choice: idx }, (ack) => {
      if (!ack?.ok) {
        status.textContent = `⚠️ ${ack?.error || 'Try again'}`;
        status.style.background = 'rgba(239,71,111,0.3)';
        lockedChoice = null;
        Array.from($('qOptions').children).forEach((n) =>
          n.classList.remove('disabled', 'locked'),
        );
      }
    });
  }

  // Reveal
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
      $('revealHeadline').innerHTML = `<span class="banner ok">✓ CORRECT</span> +${data.gained} pts`;
    } else {
      $('revealHeadline').innerHTML = `<span class="banner err">✗ WRONG</span>`;
    }
    $('revealDetail').textContent = `Correct: "${correctText}". You chose: "${yourText}".`;
    $('revealScore').textContent = data.score;

    // Save to local history
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

  // Game over
  socket.on('finished', ({ leaderboard }) => {
    stopCountdown();
    $('finalScore').textContent = myScore;

    const lb = $('finalBoard');
    lb.innerHTML = '';
    leaderboard.forEach((p) => {
      const li = document.createElement('li');
      const isMe = p.name === name;
      li.innerHTML = `<span class="lb-name">${escapeHtml(p.name)}${isMe ? ' 👈 you' : ''}</span><span class="lb-score">${p.score}</span>`;
      lb.appendChild(li);
    });

    // Local history for this room
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

  socket.on('disconnect', () => {
    const s = $('qStatus');
    if (s) { s.textContent = '⚡ Reconnecting…'; s.style.background = 'rgba(239,71,111,0.3)'; }
  });

  // Helpers
  function startCountdown(seconds) {
    stopCountdown();
    let s = seconds;
    $('qTimer').textContent = s;
    countdownTimer = setInterval(() => {
      s = Math.max(0, s - 1);
      $('qTimer').textContent = s;
      if (s === 0) stopCountdown();
    }, 1000);
  }
  function stopCountdown() { clearInterval(countdownTimer); countdownTimer = null; }

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
