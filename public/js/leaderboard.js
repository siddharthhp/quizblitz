(() => {
  const $ = (id) => document.getElementById(id);
  const show = (stepId) => {
    document.querySelectorAll('main > section').forEach((s) => s.classList.add('hidden'));
    $(stepId).classList.remove('hidden');
  };
  const setStatus = (text) => ($('status').textContent = text);

  const socket = io();
  let isFinal = false;

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
        : '<span class="pulse">●</span> Live';
    }

    if (final) return; // podium animation handles rendering

    list.innerHTML = '';
    entries.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="lb-name">${escapeHtml(p.name)}</span><span class="lb-score">${p.score}</span>`;
      list.appendChild(li);
    });
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
    const medals = ['🥉', '🥈', '🥇'];
    const delays = [600, 1800, 3200]; // 3rd, 2nd, 1st

    // Insert placeholders at top
    const placeholders = top3.map((_, i) => {
      const li = document.createElement('li');
      li.className = 'podium-hidden';
      li.style.cssText = 'opacity:0;transform:scale(0.5);transition:opacity 0.6s ease,transform 0.6s cubic-bezier(0.34,1.56,0.64,1);';
      list.insertBefore(li, list.firstChild);
      return li;
    });

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
