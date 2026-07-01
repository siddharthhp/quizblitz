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
  const TOKEN_KEY     = 'bb:hostToken';
  const CODE_KEY      = 'bb:hostCode';
  const QUESTIONS_KEY = 'bb:hostQuestions'; // questions persisted locally for auto-recreate

  function saveHostSession(code, token) {
    localStorage.setItem(CODE_KEY, code);
    localStorage.setItem(TOKEN_KEY, token);
  }
  function saveQuestionsLocally(questions) {
    try { localStorage.setItem(QUESTIONS_KEY, JSON.stringify(questions)); } catch {}
  }
  function loadQuestionsLocally() {
    try { return JSON.parse(localStorage.getItem(QUESTIONS_KEY) || 'null'); } catch { return null; }
  }
  function clearHostSession() {
    localStorage.removeItem(CODE_KEY);
    localStorage.removeItem(TOKEN_KEY);
    // keep QUESTIONS_KEY so host can re-upload on next create
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
      socket.on('connect', () => {
        socket.emit('host:resume', { code: urlCode, token: urlToken }, (ack) => {
          if (!ack?.ok) {
            // Room gone (server restarted) — auto-recreate using locally saved questions
            const savedQuestions = loadQuestionsLocally();
            if (savedQuestions && savedQuestions.length > 0) {
              $('uploadMsg').textContent = '🔄 Room expired — recreating with your saved questions…';
              $('uploadMsg').className = 'msg';
              socket.emit('host:schedule', { questions: savedQuestions }, (ack2) => {
                if (!ack2?.ok) {
                  $('uploadMsg').textContent = `❌ Could not recreate room: ${ack2?.error}`;
                  $('uploadMsg').className = 'msg error';
                  return;
                }
                saveHostSession(ack2.code, ack2.hostToken);
                // Attach questions
                socket.emit('host:setQuestions', { questions: savedQuestions }, () => {});
                roomCode = ack2.code;
                showAfterResume(ack2.code, ack2.hostToken, savedQuestions.length);
                $('uploadMsg').textContent = `✅ Room recreated (new link: ?code=${ack2.code})`;
                $('uploadMsg').className = 'msg ok';
              });
            } else {
              $('uploadMsg').textContent = '⚠️ Room expired — click Create Quiz Room to start fresh, then re-upload questions.';
              $('uploadMsg').className = 'msg error';
            }
            return;
          }
          saveHostSession(ack.code, urlToken);
          roomCode = ack.code;
          if (ack.state === 'teaser') {
            showAfterResume(ack.code, urlToken, ack.total);
          } else {
            $('questionTotal').textContent = ack.total;
            setDisplayLinks(ack.code);
            setStatus('Lobby');
            show('step-lobby');
          }
        });
      });
      return;
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
        showAfterResume(ack.code, token, ack.total);
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
        showAfterResume(ack.code, token, ack.total);
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
    if (qrContainer) {
      qrContainer.innerHTML = `<img src="/api/qr?text=${encodeURIComponent(joinUrl)}&width=140" width="140" height="140" style="border-radius:8px;display:block;" alt="QR code" />`;
    }
  }

  function showAfterResume(code, token, total) {
    setTeaserLinks(code, token);
    setStatus('Scheduled');
    // Update questions status text inside the details summary
    const statusSpan = $('questionsStatus');
    if (statusSpan) {
      if (total > 0) {
        statusSpan.textContent = `✅ ${total} questions loaded`;
        statusSpan.style.color = '#2e7d32';
      } else {
        statusSpan.textContent = '— not uploaded yet';
        statusSpan.style.color = '#c62828';
      }
    }
    $('questionTotal').textContent = total || '?';
    show('step-questions');
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
    if (qrContainer) {
      qrContainer.innerHTML = `<img src="/api/qr?text=${encodeURIComponent(teaserUrl)}&width=140" width="140" height="140" style="border-radius:8px;display:block;" alt="QR code" />`;
    }

    // Also populate the share link on the questions screen
    const shareLink = $('teaserShareLink');
    if (shareLink) { shareLink.href = teaserUrl; shareLink.textContent = teaserUrl; }
  }

  // ---- Create room (no questions needed) ----
  $('createRoomBtn').addEventListener('click', () => {
    const btn = $('createRoomBtn');
    const msg = $('uploadMsg');
    btn.disabled    = true;
    btn.textContent = '⏳ Creating room…';
    socket.emit('host:schedule', {}, (ack) => {
      btn.disabled    = false;
      btn.textContent = '🚀 Create Quiz Room';
      if (!ack?.ok) {
        msg.textContent = `❌ ${ack?.error || 'Could not create room'}`;
        msg.className   = 'msg error';
        return;
      }
      saveHostSession(ack.code, ack.hostToken);
      setTeaserLinks(ack.code, ack.hostToken);
      setStatus('Scheduled');
      show('step-questions'); // go to question upload screen
    });
  });

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

  // ---- Upload questions and attach to existing room ----
  $('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = $('file').files[0];
    if (!file) return;

    const btn = parseBtn;
    const msg = $('uploadMsg2');
    btn.disabled    = true;
    btn.textContent = '⏳ Uploading…';
    msg.textContent = `Uploading "${file.name}"…`;
    msg.className   = 'msg';

    const fd = new FormData();
    fd.append('file', file);
    try {
      const res  = await fetch('/api/upload', { method: 'POST', body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      msg.textContent = `✅ Parsed ${data.questions.length} questions — attaching to room…`;
      msg.className   = 'msg ok';

      // Attach questions to the existing teaser room (no new code)
      socket.emit('host:setQuestions', { questions: data.questions }, (ack) => {
        btn.disabled    = false;
        btn.textContent = 'Upload questions';
        if (!ack?.ok) {
          msg.textContent = `❌ ${ack?.error || 'Could not attach questions'}`;
          msg.className   = 'msg error';
          return;
        }
        saveQuestionsLocally(data.questions); // persist locally for auto-recreate on server restart
        msg.textContent = `✅ ${ack.total} questions loaded! Ready to go.`;
        msg.className   = 'msg ok';
        const statusSpan = $('questionsStatus');
        if (statusSpan) {
          statusSpan.textContent = `✅ ${ack.total} questions loaded`;
          statusSpan.style.color = '#2e7d32';
        }
        $('questionTotal').textContent = ack.total;
      });
    } catch (err) {
      btn.disabled    = false;
      btn.textContent = 'Upload questions';
      msg.textContent = `❌ ${err.message || 'Upload failed'}`;
      msg.className   = 'msg error';
    }
  });

  // Copy teaser link button on questions screen
  if ($('copyTeaserBtn')) {
    $('copyTeaserBtn').addEventListener('click', async () => {
      const link = $('teaserShareLink')?.href;
      if (!link) return;
      try {
        await navigator.clipboard.writeText(link);
        $('copyTeaserMsg').textContent = '✅ Copied!';
        setTimeout(() => { $('copyTeaserMsg').textContent = ''; }, 2000);
      } catch { $('copyTeaserMsg').textContent = link; }
    });
  }

  // "View teaser screen" button on questions step
  if ($('goToTeaserBtn')) {
    $('goToTeaserBtn').addEventListener('click', () => show('step-teaser'));
  }

  // Snapshot button — fetches base64 room snapshot, copies to clipboard
  // Paste as RESERVED_ROOM env var in Railway to make room survive all restarts
  if ($('snapshotBtn')) {
    $('snapshotBtn').addEventListener('click', async () => {
      const { token } = getSavedSession();
      if (!roomCode || !token) return;
      try {
        const res  = await fetch(`/api/room/${roomCode}/snapshot?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (!data.ok) { $('snapshotMsg').textContent = `❌ ${data.error}`; return; }
        await navigator.clipboard.writeText(`RESERVED_ROOM=${data.snapshot}`);
        $('snapshotMsg').textContent = '✅ Copied! Go to Railway → Variables → Add RESERVED_ROOM';
        $('snapshotMsg').style.color = '#2e7d32';
      } catch (e) {
        // Fallback: show the value in a prompt
        const res  = await fetch(`/api/room/${roomCode}/snapshot?token=${encodeURIComponent(token)}`);
        const data = await res.json();
        if (data.ok) prompt('Copy this value and set as RESERVED_ROOM in Railway:', `RESERVED_ROOM=${data.snapshot}`);
      }
    });
  }

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
