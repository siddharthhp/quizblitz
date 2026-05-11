(() => {
  const $ = (id) => document.getElementById(id);
  const show = (stepId) => {
    document.querySelectorAll('main > section').forEach((s) => s.classList.add('hidden'));
    $(stepId).classList.remove('hidden');
  };
  const setStatus = (text) => ($('status').textContent = text);

  const socket = io();
  let countdownTimer = null;
  let roomCode = null;

  function setDisplayLinks(code) {
    roomCode = code;
    const displayUrl = `/leaderboard.html?room=${code}`;
    const joinUrl = `${location.origin}/?code=${code}`;

    ['displayUrl', 'displayUrlQ', 'displayUrlR', 'displayUrlF'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.href = `${location.origin}${displayUrl}`;
      if (id === 'displayUrl') el.textContent = `${location.origin}${displayUrl}`;
    });

    // Join link anchor
    const anchor = $('joinLinkAnchor');
    if (anchor) {
      anchor.href = joinUrl;
      anchor.textContent = joinUrl;
    }

    // QR code
    const qrContainer = $('qrCanvas');
    if (qrContainer && typeof QRCode !== 'undefined') {
      qrContainer.innerHTML = '';
      QRCode.toCanvas(joinUrl, { width: 140, margin: 1, color: { dark: '#041e42', light: '#ffffff' } }, (err, canvas) => {
        if (!err) qrContainer.appendChild(canvas);
      });
    }
  }

  // ---- File picker UX ----
  const fileInput = $('file');
  const fileLabel = $('fileLabel');
  const fileLabelText = $('fileLabelText');
  const fileSpinner = $('fileSpinner');
  const parseBtn = $('parseBtn');

  fileLabel.addEventListener('dragover', (e) => { e.preventDefault(); fileLabel.classList.add('drag'); });
  fileLabel.addEventListener('dragleave', () => fileLabel.classList.remove('drag'));
  fileLabel.addEventListener('drop', (e) => {
    e.preventDefault();
    fileLabel.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.docx')) {
      setFileReady(f);
    } else {
      fileLabelText.textContent = '❌ Only .docx files allowed';
      fileLabel.classList.remove('ready');
    }
  });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    // Show spinner while browser reads the file into memory
    fileLabel.classList.remove('ready', 'drag');
    fileLabelText.textContent = `Loading "${f.name}"…`;
    fileSpinner.classList.remove('hidden');
    parseBtn.disabled = true;
    // Use FileReader to confirm file is readable before enabling Parse
    const reader = new FileReader();
    reader.onload = () => setFileReady(f);
    reader.onerror = () => {
      fileSpinner.classList.add('hidden');
      fileLabelText.textContent = '❌ Could not read file';
    };
    reader.readAsArrayBuffer(f);
  });

  function setFileReady(f) {
    fileSpinner.classList.add('hidden');
    fileLabel.classList.add('ready');
    fileLabelText.textContent = `✅ "${f.name}" ready (${(f.size / 1024).toFixed(0)} KB)`;
    parseBtn.disabled = false;
  }

  // Step 1: upload
  $('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('file').files[0];
    if (!file) return;

    const btn = parseBtn;
    const msg = $('uploadMsg');
    btn.disabled = true;
    btn.textContent = '⏳ Parsing…';
    msg.textContent = `Uploading "${file.name}"…`;
    msg.className = 'msg';

    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      msg.textContent = `✅ Parsed ${data.questions.length} questions! Creating room…`;
      msg.className = 'msg ok';
      btn.textContent = '🔄 Creating room…';

      socket.emit('host:create', { questions: data.questions }, (ack) => {
        btn.disabled = false;
        btn.textContent = 'Parse';
        if (!ack?.ok) {
          msg.textContent = `❌ ${ack?.error || 'Could not create room'}`;
          msg.className = 'msg error';
          parseBtn.disabled = false;
          return;
        }
        $('roomCode').textContent = ack.code;
        $('questionTotal').textContent = ack.total;
        setDisplayLinks(ack.code);
        setStatus('Lobby');
        show('step-lobby');
      });
    } catch (err) {
      btn.disabled = false;
      btn.textContent = 'Parse';
      parseBtn.disabled = false;
      msg.textContent = `❌ ${err.message || 'Upload failed'}`;
      msg.className = 'msg error';
    }
  });

  // Lobby — live join feed
  const seenPlayers = new Set();
  socket.on('roster', ({ players }) => {
    $('playerCount').textContent = players.length;
    $('startBtn').disabled = players.length === 0;
    const list = $('playerList');
    // Animate newly joined players
    players.forEach((p) => {
      if (!seenPlayers.has(p.name)) {
        seenPlayers.add(p.name);
        const li = document.createElement('li');
        li.textContent = `${p.avatar || ''} ${p.name}`.trim();
        list.prepend(li); // newest at top
      }
    });
  });

  $('startBtn').addEventListener('click', () => {
    socket.emit('host:start', null, (ack) => {
      if (!ack?.ok) alert(ack?.error || 'Could not start');
    });
  });

  // Pre-game countdown overlay
  let hostOverlayTimer = null;
  socket.on('pre-question', ({ seconds }) => {
    let overlay = $('hostCountdownOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'hostCountdownOverlay';
      overlay.style.cssText = [
        'position:fixed;inset:0;z-index:999',
        'display:flex;flex-direction:column;align-items:center;justify-content:center',
        'background:rgba(4,30,66,0.88)',
        'backdrop-filter:blur(6px)',
        'color:#fff',
        'font-family:inherit',
        'pointer-events:none',
      ].join(';');
      overlay.innerHTML = `
        <div style="font-size:20px;font-weight:700;letter-spacing:0.05em;margin-bottom:16px;opacity:0.85;">GAME STARTING!</div>
        <div id="hostOverlayCount" style="font-size:120px;font-weight:900;line-height:1;color:#ffc220;text-shadow:0 0 40px rgba(255,194,32,0.6);"></div>
      `;
      document.body.appendChild(overlay);
    }
    if (hostOverlayTimer) clearInterval(hostOverlayTimer);
    let s = seconds;
    const countEl = overlay.querySelector('#hostOverlayCount');
    overlay.style.display = 'flex';
    countEl.textContent = s;
    hostOverlayTimer = setInterval(() => {
      s -= 1;
      if (s <= 0) {
        clearInterval(hostOverlayTimer);
        hostOverlayTimer = null;
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

  // Question
  socket.on('question', ({ index, total, durationMs, question, options }) => {
    setStatus(`Q ${index + 1} / ${total}`);
    $('qIndex').textContent = `Q ${index + 1} / ${total}`;
    $('qText').textContent = question;
    const list = $('qOptions');
    list.innerHTML = '';
    options.forEach((text, i) => {
      const li = document.createElement('li');
      li.dataset.letter = String.fromCharCode(65 + i);
      li.innerHTML = `<span class="letter">${li.dataset.letter}</span><span>${escapeHtml(text)}</span>`;
      list.appendChild(li);
    });
    show('step-question');
    startCountdown(Math.round(durationMs / 1000));
  });

$('skipBtn').addEventListener('click', () => socket.emit('host:skip'));

  function endQuiz() {
    if (!confirm('End the quiz now? This will show final standings to all players.')) return;
    socket.emit('host:end', null, (ack) => {
      if (!ack?.ok) alert(ack?.error || 'Could not end quiz');
    });
  }
  $('endQuizBtnQ').addEventListener('click', endQuiz);
  $('endQuizBtnR').addEventListener('click', endQuiz);

  // Reveal
  socket.on('reveal', (data) => {
    if (!('counts' in data)) return; // player-shaped reveal, ignore
    stopCountdown();
    const optNodes = Array.from($('qOptions').children);
    const list = $('revealOptions');
    list.innerHTML = '';
    optNodes.forEach((node, i) => {
      const li = document.createElement('li');
      const letter = String.fromCharCode(65 + i);
      li.dataset.letter = letter;
      li.innerHTML =
        `<span class="letter">${letter}</span>` +
        `<span>${node.children[1].textContent} — <strong>${data.counts[i] || 0} votes</strong></span>`;
      li.classList.add(i === data.correctIndex ? 'correct' : 'wrong');
      list.appendChild(li);
    });

    // Fastest answer callout
    const fastestEl = $('fastestCallout');
    if (fastestEl) {
      if (data.fastest) {
        const secs = (data.fastest.ms / 1000).toFixed(1);
        fastestEl.textContent = `⚡ Fastest: ${data.fastest.name} (${secs}s)`;
        fastestEl.classList.remove('hidden');
      } else {
        fastestEl.classList.add('hidden');
      }
    }

    setStatus('Reveal');
    show('step-reveal');
  });

  $('nextBtn').addEventListener('click', () => socket.emit('host:next'));

  // Finished
  socket.on('finished', ({ leaderboard }) => {
    stopCountdown();
    const lb = $('finalBoard');
    lb.innerHTML = '';
    leaderboard.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="lb-name">${escapeHtml(p.name)}</span><span class="lb-score">${p.score}</span>`;
      lb.appendChild(li);
    });
    setStatus('Finished');
    show('step-finished');
  });

  socket.on('disconnect', () => setStatus('Disconnected'));

  // Helpers
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
      if (s <= 3) el.classList.add('critical');
      else if (s <= 10) el.classList.add('warning');
      if (s === 0) stopCountdown();
    }, 1000);
  }
  function stopCountdown() {
    clearInterval(countdownTimer);
    countdownTimer = null;
    const el = $('qTimer');
    if (el) el.classList.remove('warning', 'critical');
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }
})();
