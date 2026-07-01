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

  // ---- Host token (for resuming scheduled/teaser rooms) ----
  const TOKEN_KEY = 'bb:hostToken';
  const CODE_KEY  = 'bb:hostCode';

  function saveHostSession(code, token) {
    localStorage.setItem(CODE_KEY, code);
    localStorage.setItem(TOKEN_KEY, token);
  }
  function clearHostSession() {
    localStorage.removeItem(CODE_KEY);
    localStorage.removeItem(TOKEN_KEY);
  }
  function getSavedSession() {
    return { code: localStorage.getItem(CODE_KEY), token: localStorage.getItem(TOKEN_KEY) };
  }

  // ---- Auto-resume from URL params (?code=X&token=Y) ----
  // This lets the host bookmark a direct link that works from any browser/device.
  (async function checkUrlResume() {
    const urlParams = new URLSearchParams(location.search);
    const urlCode  = (urlParams.get('code')  || '').toUpperCase().trim();
    const urlToken = (urlParams.get('token') || '').trim();
    if (urlCode && urlToken) {
      // Auto-resume immediately from URL
      socket.on('connect', () => {
        socket.emit('host:resume', { code: urlCode, token: urlToken }, (ack) => {
          if (!ack?.ok) {
            $('uploadMsg').textContent = `⚠️ Could not resume room ${urlCode}: ${ack?.error || 'Invalid token'}`;
            $('uploadMsg').className = 'msg error';
            return;
          }
          saveHostSession(ack.code, urlToken);
          roomCode = ack.code;
          if (ack.state === 'teaser') {
            setTeaserLinks(ack.code, urlToken);
            setStatus('Scheduled');
            show('step-teaser');
          } else {
            $('questionTotal').textContent = ack.total;
            setDisplayLinks(ack.code);
            setStatus('Lobby');
            show('step-lobby');
          }
        });
      });
      return; // skip localStorage check
    }

    // Check localStorage for a saved session
    const { code, token } = getSavedSession();
    if (!code || !token) return;
    try {
      const res = await fetch(`/api/room/${code}`);
      if (!res.ok) { clearHostSession(); return; }
      const data = await res.json();
      if (data.state === 'teaser') {
        $('resumeCode').textContent = code;
        $('resumeBox').classList.remove('hidden');
      } else if (data.state === 'lobby' || data.state === 'question') {
        clearHostSession();
      }
    } catch { /* server unreachable */ }
  })();

  // ---- Manual resume toggle ----
  $('manualResumeToggle').addEventListener('click', () => {
    $('manualResumeBox').classList.toggle('hidden');
  });

  $('manualResumeBtn').addEventListener('click', () => {
    const raw   = ($('manualResumeUrl').value || '').trim();
    const msg   = $('manualResumeMsg');
    let code, token;
    // Accept full URL or "code:token" shorthand
    try {
      const url   = new URL(raw);
      code  = (url.searchParams.get('code')  || '').toUpperCase().trim();
      token = (url.searchParams.get('token') || '').trim();
    } catch {
      // Try "code:token" format
      const parts = raw.split(':');
      code  = (parts[0] || '').toUpperCase().trim();
      token = (parts[1] || '').trim();
    }
    if (!code || !token) {
      msg.textContent = 'Paste the full host URL or enter code:token';
      msg.className = 'msg error';
      return;
    }
    msg.textContent = 'Connecting…';
    msg.className = 'msg';
    socket.emit('host:resume', { code, token }, (ack) => {
      if (!ack?.ok) {
        msg.textContent = `❌ ${ack?.error || 'Could not resume'}`;
        msg.className = 'msg error';
        return;
      }
      saveHostSession(ack.code, token);
      roomCode = ack.code;
      if (ack.state === 'teaser') {
        setTeaserLinks(ack.code, token);
        setStatus('Scheduled');
        show('step-teaser');
      } else {
        $('questionTotal').textContent = ack.total;
        setDisplayLinks(ack.code);
        setStatus('Lobby');
        show('step-lobby');
      }
    });
  });

  $('resumeBtn').addEventListener('click', () => {
    const { code, token } = getSavedSession();
    if (!code || !token) return;
    socket.emit('host:resume', { code, token }, (ack) => {
      if (!ack?.ok) {
        alert(ack?.error || 'Could not resume');
        clearHostSession();
        return;
      }
      roomCode = ack.code;
      if (ack.state === 'teaser') {
        setTeaserLinks(ack.code, token);
        setStatus('Scheduled');
        show('step-teaser');
      } else {
        $('questionTotal').textContent = ack.total;
        setDisplayLinks(ack.code);
        setStatus('Lobby');
        show('step-lobby');
      }
    });
  });

  function setDisplayLinks(code) {
    roomCode = code;
    const displayUrl = `/leaderboard.html?room=${code}`;
    const joinUrl    = `${location.origin}/?code=${code}`;

    ['displayUrl', 'displayUrlQ', 'displayUrlR', 'displayUrlF'].forEach((id) => {
      const el = $(id);
      if (!el) return;
      el.href = `${location.origin}${displayUrl}`;
      if (id === 'displayUrl') el.textContent = `${location.origin}${displayUrl}`;
    });

    const anchor = $('joinLinkAnchor');
    if (anchor) { anchor.href = joinUrl; anchor.textContent = joinUrl; }

    const qrContainer = $('qrCanvas');
    if (qrContainer && typeof QRCode !== 'undefined') {
      qrContainer.innerHTML = '';
      QRCode.toCanvas(joinUrl, { width: 140, margin: 1, color: { dark: '#041e42', light: '#ffffff' } }, (err, canvas) => {
        if (!err) qrContainer.appendChild(canvas);
      });
    }
  }

  function setTeaserLinks(code, token) {
    roomCode = code;
    const teaserUrl = `${location.origin}/teaser.html?code=${code}`;
    const anchor    = $('teaserLinkAnchor');
    if (anchor) { anchor.href = teaserUrl; anchor.textContent = teaserUrl; }

    // Host resume URL — bookmark this to resume from any browser
    const tok = token || getSavedSession().token || '';
    const resumeUrl = `${location.origin}/host.html?code=${code}&token=${tok}`;
    const resumeAnchor = $('hostResumeUrl');
    if (resumeAnchor) { resumeAnchor.href = resumeUrl; resumeAnchor.textContent = resumeUrl; }

    const qrContainer = $('teaserQrCanvas');
    if (qrContainer && typeof QRCode !== 'undefined') {
      qrContainer.innerHTML = '';
      QRCode.toCanvas(teaserUrl, { width: 140, margin: 1, color: { dark: '#041e42', light: '#ffffff' } }, (err, canvas) => {
        if (!err) qrContainer.appendChild(canvas);
      });
    }
  }

  // ---- File picker UX ----
  const fileInput    = $('file');
  const fileLabel    = $('fileLabel');
  const fileLabelText = $('fileLabelText');
  const fileSpinner  = $('fileSpinner');
  const parseBtn     = $('parseBtn');

  fileLabel.addEventListener('dragover', (e) => { e.preventDefault(); fileLabel.classList.add('drag'); });
  fileLabel.addEventListener('dragleave', () => fileLabel.classList.remove('drag'));
  fileLabel.addEventListener('drop', (e) => {
    e.preventDefault();
    fileLabel.classList.remove('drag');
    const f = e.dataTransfer.files[0];
    if (f && f.name.endsWith('.docx')) setFileReady(f);
    else { fileLabelText.textContent = '❌ Only .docx files allowed'; fileLabel.classList.remove('ready'); }
  });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files[0];
    if (!f) return;
    fileLabel.classList.remove('ready', 'drag');
    fileLabelText.textContent = `Loading "${f.name}"…`;
    fileSpinner.classList.remove('hidden');
    parseBtn.disabled = true;
    const reader = new FileReader();
    reader.onload  = () => setFileReady(f);
    reader.onerror = () => { fileSpinner.classList.add('hidden'); fileLabelText.textContent = '❌ Could not read file'; };
    reader.readAsArrayBuffer(f);
  });

  function setFileReady(f) {
    fileSpinner.classList.add('hidden');
    fileLabel.classList.add('ready');
    fileLabelText.textContent = `✅ "${f.name}" ready (${(f.size / 1024).toFixed(0)} KB)`;
    parseBtn.disabled = false;
  }

  // ---- Upload & create room ----
  let parsedQuestions = null;

  $('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('file').files[0];
    if (!file) return;

    const btn = parseBtn;
    const msg = $('uploadMsg');
    btn.disabled    = true;
    btn.textContent = '⏳ Parsing…';
    msg.textContent = `Uploading "${file.name}"…`;
    msg.className   = 'msg';

    const fd = new FormData();
    fd.append('file', file);
    try {
      const res  = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      parsedQuestions = data.questions;
      msg.textContent = `✅ Parsed ${data.questions.length} questions! Creating room…`;
      msg.className   = 'msg ok';
      btn.textContent = '🔄 Creating room…';

      socket.emit('host:create', { questions: data.questions }, (ack) => {
        btn.disabled    = false;
        btn.textContent = 'Parse';
        if (!ack?.ok) {
          msg.textContent = `❌ ${ack?.error || 'Could not create room'}`;
          msg.className   = 'msg error';
          parseBtn.disabled = false;
          return;
        }
        saveHostSession(ack.code, ack.hostToken);
        $('questionTotal').textContent = ack.total;
        setDisplayLinks(ack.code);
        setStatus('Lobby');
        show('step-lobby');
      });
    } catch (err) {
      btn.disabled    = false;
      btn.textContent = 'Parse';
      parseBtn.disabled = false;
      msg.textContent = `❌ ${err.message || 'Upload failed'}`;
      msg.className   = 'msg error';
    }
  });

  // ---- Lobby ----
  const seenPlayers = new Set();
  socket.on('roster', ({ players }) => {
    $('playerCount').textContent = players.length;
    $('startBtn').disabled = players.length === 0;
    const list = $('playerList');
    players.forEach((p) => {
      if (!seenPlayers.has(p.name)) {
        seenPlayers.add(p.name);
        const li = document.createElement('li');
        li.textContent = `${p.avatar || ''} ${p.name}`.trim();
        list.prepend(li);
      }
    });
  });

  $('startBtn').addEventListener('click', () => {
    socket.emit('host:start', null, (ack) => {
      if (!ack?.ok) alert(ack?.error || 'Could not start');
    });
  });

  // Schedule for later — flips room to teaser state
  $('scheduleBtn').addEventListener('click', () => {
    if (!roomCode || !parsedQuestions) return;
    const { token } = getSavedSession();
    // Use host:schedule to create a new teaser room with the already-parsed questions
    // (We already have a lobby room; schedule creates a replacement teaser room)
    socket.emit('host:schedule', { questions: parsedQuestions }, (ack) => {
      if (!ack?.ok) { alert(ack?.error || 'Could not schedule'); return; }
      saveHostSession(ack.code, ack.hostToken);
      setTeaserLinks(ack.code, ack.hostToken);
      setStatus('Scheduled');
      show('step-teaser');
    });
  });

  // ---- Teaser screen ----
  $('teaserStartBtn').addEventListener('click', () => {
    socket.emit('host:start', null, (ack) => {
      if (!ack?.ok) { alert(ack?.error || 'Could not start'); return; }
      if (ack.teaser) {
        // Room flipped to lobby — players are now being redirected to join form.
        // Enable Start Game immediately so host can fire questions as soon as
        // enough players have registered.
        setDisplayLinks(roomCode);
        const joinUrl = `${location.origin}/?code=${roomCode}`;
        $('joinLinkAnchor').href        = joinUrl;
        $('joinLinkAnchor').textContent = joinUrl;
        $('questionTotal').textContent  = '?';
        setStatus('Open — players joining');
        // Enable start button — host decides when enough players are in
        $('startBtn').disabled = false;
        // Show a helper message in the lobby
        const hint = document.createElement('p');
        hint.id = 'teaserHint';
        hint.style.cssText = 'font-size:14px;color:#546e7a;margin-top:8px;';
        hint.textContent = '✅ Quiz is open! Players are joining now. Press Start Game when ready.';
        const startBtn = $('startBtn');
        startBtn.parentNode.insertBefore(hint, startBtn.nextSibling);
        show('step-lobby');
      }
    });
  });

  // ---- Question ----
  socket.on('question', ({ index, total, durationMs, question, options }) => {
    setStatus(`Q ${index + 1} / ${total}`);
    $('qIndex').textContent = `Q ${index + 1} / ${total}`;
    $('qText').textContent  = question;
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

  // ---- Reveal ----
  socket.on('reveal', (data) => {
    if (!('counts' in data)) return;
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

  // ---- Finished ----
  socket.on('finished', ({ leaderboard }) => {
    stopCountdown();
    clearHostSession();
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

  // ---- Helpers ----
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
