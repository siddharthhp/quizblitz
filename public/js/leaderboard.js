(() => {
  const $ = (id) => document.getElementById(id);
  const show = (stepId) => {
    document.querySelectorAll('main > section').forEach((s) => s.classList.add('hidden'));
    $(stepId).classList.remove('hidden');
  };
  const setStatus = (text) => ($('status').textContent = text);

  const socket = io();
  let isFinal = false;
  let prevRanks = new Map(); // name -> rank (1-based), reset on each display:join

  // Auto-join if ?room= param present
  const params = new URLSearchParams(location.search);
  const autoCode = (params.get('room') || '').toUpperCase().trim();
  if (autoCode) {
    socket.on('connect', () => joinRoom(autoCode));
  } else {
    show('step-join');
  }

  $('joinForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const code = ($('roomInput').value || '').toUpperCase().trim();
    if (!code) return;
    joinRoom(code);
  });

  function joinRoom(code) {
    $('joinMsg').textContent = `Connecting to ${code}…`;
    $('joinMsg').className = 'msg';
    socket.emit('display:join', { code }, (ack) => {
      if (!ack?.ok) {
        $('joinMsg').textContent = `❌ ${ack?.error || 'Room not found'}`;
        $('joinMsg').className = 'msg error';
        show('step-join');
        return;
      }
      prevRanks = new Map(); // reset rank history on fresh join
      setStatus(code);
      // Show player count if still in lobby
      if (ack.state === 'lobby') {
        updatePlayerCount((ack.players || []).length);
      }
      hideVoteChart();
      renderLeaderboard(ack.leaderboard, ack.state === 'finished');
      if (ack.state === 'finished') {
        runPodiumAnimation(ack.leaderboard);
      }
      show('step-live');
    });
  }

  // Live player count in lobby phase
  socket.on('roster', ({ players }) => {
    updatePlayerCount(players.length);
  });

  function updatePlayerCount(n) {
    const el = $('lobbyPlayerCount');
    if (!el) return;
    el.textContent = `${n} player${n === 1 ? '' : 's'} joined`;
    el.classList.toggle('hidden', false);
  }

  // Vote distribution chart after each question reveal
  socket.on('reveal:stats', ({ counts, correctIndex, options, fastest, totalAnswered }) => {
    renderVoteChart(counts, correctIndex, options, fastest, totalAnswered);
  });

  function renderVoteChart(counts, correctIndex, options, fastest, totalAnswered) {
    const section = $('step-votes');
    if (!section) return;

    const total = totalAnswered || counts.reduce((a, b) => a + b, 0) || 1;
    const LETTERS = ['A', 'B', 'C', 'D', 'E', 'F'];
    const COLORS = ['#ef476f', '#118ab2', '#ffd166', '#06d6a0', '#c77dff', '#f95738'];

    const barsHtml = counts.map((c, i) => {
      const pct = Math.round((c / total) * 100);
      const isCorrect = i === correctIndex;
      return `
        <div class="vote-row${isCorrect ? ' correct' : ''}">
          <span class="vote-letter" style="background:${COLORS[i % COLORS.length]}">${LETTERS[i]}</span>
          <div class="vote-bar-track">
            <div class="vote-bar" style="width:${pct}%;background:${isCorrect ? '#06d6a0' : COLORS[i % COLORS.length]}"></div>
          </div>
          <span class="vote-pct">${pct}%</span>
          <span class="vote-count">(${c})</span>
        </div>`;
    }).join('');

    let fastestHtml = '';
    if (fastest) {
      const secs = (fastest.ms / 1000).toFixed(1);
      fastestHtml = `<div class="fastest-callout">⚡ Fastest correct: <strong>${escapeHtml(fastest.name)}</strong> in ${secs}s</div>`;
    }

    $('voteBars').innerHTML = barsHtml;
    $('fastestDisplay').innerHTML = fastestHtml;

    // Show vote section, hide leaderboard temporarily
    section.classList.remove('hidden');
    const lbSection = $('step-live');
    // We show both — vote chart above leaderboard
  }

  function hideVoteChart() {
    const section = $('step-votes');
    if (section) section.classList.add('hidden');
  }

  socket.on('pre-question', ({ seconds }) => {
    showCountdownOverlay(seconds);
  });

  socket.on('leaderboard:update', ({ leaderboard, final }) => {
    hideVoteChart();
    renderLeaderboard(leaderboard, final);
    if (final) {
      runPodiumAnimation(leaderboard);
    }
  });

  socket.on('disconnect', () => {
    setStatus('Disconnected');
    if ($('liveStatus')) {
      $('liveStatus').textContent = '⚠️ Disconnected — refresh to reconnect';
    }
  });

  function renderLeaderboard(entries, final) {
    isFinal = final;
    const list = $('lbList');
    list.className = `leaderboard${final ? ' final' : ''}`;

    const title = $('lbTitle');
    const subtitle = $('lbSubtitle');
    title.textContent = final ? '🏆 Final Standings' : '🏆 Leaderboard';
    subtitle.textContent = final ? 'Game over!' : 'Live standings';

    if ($('liveStatus')) {
      $('liveStatus').innerHTML = final
        ? '✅ Final'
        : '<span class="pulse">●</span> LIVE · Walmart Retail Services All Hands 2026';
    }

    if (final) return; // podium animation handles rendering

    // Compute rank arrows relative to previous frame
    const hasBaseline = prevRanks.size > 0;
    const newRanks = new Map();
    entries.forEach((p, i) => newRanks.set(p.name, i + 1));

    list.innerHTML = '';
    entries.forEach((p, i) => {
      const li = document.createElement('li');
      let arrow = '';
      if (hasBaseline) {
        const was = prevRanks.get(p.name);
        if (was == null) {
          arrow = ''; // new entrant — no arrow
        } else if (was > i + 1) {
          arrow = `<span class="rank-up" title="Up ${was - (i+1)}">↑</span>`;
        } else if (was < i + 1) {
          arrow = `<span class="rank-down" title="Down ${(i+1) - was}">↓</span>`;
        }
      }
      li.innerHTML = `<span class="lb-name">${escapeHtml(p.name)}</span>${arrow}<span class="lb-score">${p.score}</span>`;
      list.appendChild(li);
    });

    prevRanks = newRanks;
  }

  // ---- Pre-game countdown overlay ----
  let overlayTimer = null;
  function showCountdownOverlay(seconds) {
    let overlay = $('countdownOverlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'countdownOverlay';
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
        <div style="font-size:20px;font-weight:700;letter-spacing:0.05em;margin-bottom:16px;opacity:0.85;">GET READY!</div>
        <div id="overlayCount" style="font-size:120px;font-weight:900;line-height:1;color:#ffc220;text-shadow:0 0 40px rgba(255,194,32,0.6);"></div>
      `;
      document.body.appendChild(overlay);
    }

    if (overlayTimer) clearInterval(overlayTimer);
    let s = seconds;
    const countEl = overlay.querySelector('#overlayCount');
    overlay.style.display = 'flex';
    countEl.textContent = s;
    countEl.style.transform = 'scale(1)';

    overlayTimer = setInterval(() => {
      s -= 1;
      if (s <= 0) {
        clearInterval(overlayTimer);
        overlayTimer = null;
        overlay.style.display = 'none';
        return;
      }
      countEl.textContent = s;
      // Pulse animation via inline style reset trick
      countEl.style.transform = 'scale(1.3)';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        countEl.style.transition = 'transform 0.4s cubic-bezier(0.34,1.56,0.64,1)';
        countEl.style.transform = 'scale(1)';
      }));
    }, 1000);
  }

  // Podium ceremony: reveal #3, #2, #1 with staggered delays
  function runPodiumAnimation(entries) {
    const list = $('lbList');
    list.innerHTML = '';
    list.className = 'leaderboard final';

    const top3 = entries.slice(0, 3);
    const rest = entries.slice(3);

    // Show 4th+ immediately (no fanfare)
    rest.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="lb-name">${escapeHtml(p.name)}</span><span class="lb-score">${p.score}</span>`;
      li.style.opacity = '0.7';
      list.appendChild(li);
    });

    // Reveal #3, #2, #1 in reverse order with delays
    // medals[0]=🥇(1st), medals[1]=🥈(2nd), medals[2]=🥉(3rd)
    const medals = ['🥇', '🥈', '🥉'];
    const delays = [3200, 1800, 600]; // 1st revealed last, 3rd first

    // Insert placeholders at top IN ORDER so DOM is [1st, 2nd, 3rd, ...rest]
    // insertBefore(firstChild) reverses insertion order, so insert in reverse: 3rd, 2nd, 1st
    const placeholders = [];
    for (let i = 0; i < top3.length; i++) placeholders.push(null);
    for (let i = top3.length - 1; i >= 0; i--) {
      const li = document.createElement('li');
      li.style.cssText = 'opacity:0;transform:scale(0.5);transition:opacity 0.6s ease,transform 0.6s cubic-bezier(0.34,1.56,0.64,1);';
      list.insertBefore(li, list.firstChild);
      placeholders[i] = li;
    }

    // Reveal from 3rd to 1st
    [2, 1, 0].forEach((rank) => {
      const p = top3[rank];
      if (!p) return;
      setTimeout(() => {
        const li = placeholders[rank];
        li.innerHTML = `<span class="lb-name">${medals[rank]} ${escapeHtml(p.name)}</span><span class="lb-score">${p.score}</span>`;
        // Force reflow then animate in
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            li.style.opacity = '1';
            li.style.transform = 'scale(1)';
          });
        });
        // Confetti burst for 1st place
        if (rank === 0 && typeof confetti === 'function') {
          setTimeout(() => {
            confetti({ particleCount: 200, spread: 100, origin: { y: 0.4 }, colors: ['#ffd166', '#ef476f', '#c77dff', '#06d6a0'] });
            setTimeout(() => confetti({ particleCount: 100, spread: 70, angle: 60, origin: { x: 0, y: 0.5 } }), 300);
            setTimeout(() => confetti({ particleCount: 100, spread: 70, angle: 120, origin: { x: 1, y: 0.5 } }), 500);
          }, 400);
        }
      }, delays[rank]);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }
})();
