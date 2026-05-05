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
    // Wait for socket connect, then join
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
      renderLeaderboard(ack.leaderboard, ack.state === 'finished');
      show('step-live');
    });
  }

  socket.on('leaderboard:update', ({ leaderboard, final }) => {
    renderLeaderboard(leaderboard, final);
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

    list.innerHTML = '';
    entries.forEach((p) => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="lb-name">${escapeHtml(p.name)}</span><span class="lb-score">${p.score}</span>`;
      list.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]),
    );
  }
})();
