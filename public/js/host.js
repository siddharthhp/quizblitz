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
    const qrUrl = `/join.html?room=${code}`;
    ['displayUrl', 'displayUrlQ', 'displayUrlR', 'displayUrlF'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.href = displayUrl;
      if (id === 'displayUrl') el.textContent = `${location.origin}${displayUrl}`;
    });
    // QR join page link in lobby
    const qrLink = $('qrPageUrl');
    if (qrLink) {
      qrLink.href = qrUrl;
      qrLink.textContent = `${location.origin}${qrUrl}`;
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
        $('joinUrl').textContent = `${location.origin}  ·  code: ${ack.code}`;
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
        li.textContent = p.name;
        list.prepend(li); // newest at top
      }
    });
  });

  $('startBtn').addEventListener('click', () => {
    socket.emit('host:start', null, (ack) => {
      if (!ack?.ok) alert(ack?.error || 'Could not start');
    });
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
    $('answeredCount').textContent = `0 / ? answered`;
    show('step-question');
    startCountdown(Math.round(durationMs / 1000));
  });

  socket.on('answer:tick', ({ answered, total }) => {
    $('answeredCount').textContent = `${answered} / ${total} answered`;
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

    const lb = $('leaderboard');
    lb.innerHTML = '';
    data.leaderboard.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="lb-name">${escapeHtml(p.name)}</span><span class="lb-score">${p.score}</span>`;
      lb.appendChild(li);
    });
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
