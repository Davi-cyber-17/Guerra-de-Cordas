(() => {
  'use strict';

  const $ = s => document.querySelector(s);
  const WIN = 3;            // pontos para vencer a partida
  const SWIPE_K = 0.18;     // quanto a corda anda ao arrastar a zona inteira
  const MAX_EVT = 0.05;     // limite por evento de movimento (evita "teleporte")
  const KEY_STEP = 0.07;    // passo de cada tecla (teclado)
  const RATE = 1.1;         // limite de força por segundo (igual para os dois lados)
  const BURST = 0.12;
  const PREFIX = 'pulltherope-';
  const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  // STUN + TURN de reserva: ajuda a conectar celular (4G) com computador (Wi-Fi) em redes diferentes
  const PEER_OPTS = { config: { iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    // TURN público gratuito (reserva). Para conexão garantida, crie uma conta grátis em metered.ca
    // e troque usuário/senha abaixo pelas suas credenciais.
    { urls: ['turn:openrelay.metered.ca:80', 'turn:openrelay.metered.ca:443', 'turn:openrelay.metered.ca:443?transport=tcp', 'turns:openrelay.metered.ca:443?transport=tcp'],
      username: 'openrelayproject', credential: 'openrelayproject' }
  ], iceCandidatePoolSize: 4 } };
  let wakeLock = null, joinTimer = null;
  async function keepAwake() { try { wakeLock = await navigator.wakeLock.request('screen'); } catch (e) {} }

  const app = $('#app');
  const zones = { me: $('#zoneMe'), opp: $('#zoneOpp') };
  const isLand = () => window.matchMedia('(orientation: landscape)').matches;

  let mode = null;        // 'local' | 'host' | 'guest'
  let myIdx = 0;          // 0 = vermelho (host), 1 = azul (convidado)
  let peer = null, conn = null;
  let timer = null, goTimer = null;

  // Estado do jogo. p > 0: corda puxada para o jogador 0.
  let G = fresh();
  function fresh() { return { p: 0, s: [0, 0], phase: 'idle', count: 0, go: false, w: null }; }

  /* ---------------- Telas ---------------- */
  function show(id) {
    ['menu', 'online', 'game'].forEach(n => $('#' + n).classList.toggle('hidden', n !== id));
  }
  function setStatus(t) { $('#status').textContent = t || ''; }

  function leave(msg) {
    clearTimeout(timer); clearTimeout(goTimer); clearTimeout(joinTimer); clearTimeout(qTimer); clearTimeout(sendT);
    qTimer = sendT = null; queued = 0; dirty = false;
    try { wakeLock && wakeLock.release(); } catch (e) {}
    try { conn && conn.close(); } catch (e) {}
    try { peer && peer.destroy(); } catch (e) {}
    clearInterval(pingT); $('#ping').classList.add('hidden');
    peer = conn = null; mode = null;
    G = fresh();
    app.dataset.mode = '';
    app.classList.remove('live');
    Object.values(zones).forEach(z => z.classList.remove('drag'));
    $('#lobbyChoose').classList.remove('hidden');
    $('#lobbyWait').classList.add('hidden');
    setStatus(msg || '');
    show(msg ? 'online' : 'menu');
  }

  /* ---------------- Lógica (local e host) ---------------- */
  // Limitador de força: ninguém ganha vantagem só por mexer o mouse/dedo mais rápido do que o normal
  const bucket = [{ t: 0, v: BURST }, { t: 0, v: BURST }];
  function resetBuckets() {
    const now = performance.now();
    bucket[0] = { t: now, v: BURST }; bucket[1] = { t: now, v: BURST };
  }
  function allow(i, a) {
    const now = performance.now(), b = bucket[i];
    b.v = Math.min(BURST, b.v + (now - b.t) / 1000 * RATE); b.t = now;
    const g = Math.min(a, b.v); b.v -= g;
    return g;
  }

  function startMatch() {
    G = fresh();
    startRound();
  }
  function startRound() {
    clearTimeout(timer); clearTimeout(goTimer);
    G.p = 0; G.phase = 'count'; G.count = 3; G.go = false; G.w = null;
    lastHand.me = lastHand.opp = null;
    sync();
    timer = setTimeout(step, 800);
  }
  function step() {
    if (G.count > 1) {
      G.count--; sync();
      timer = setTimeout(step, 800);
    } else {
      G.phase = 'play'; G.count = 0; G.go = true; resetBuckets(); sync();
      goTimer = setTimeout(() => { G.go = false; sync(); }, 700);
    }
  }
  function pull(i, a) {
    if (G.phase !== 'play') return;
    a = allow(i, a);
    if (!(a > 0)) return;
    G.p = Math.max(-1, Math.min(1, G.p + (i === 0 ? a : -a)));
    if (Math.abs(G.p) >= 1) {
      const w = G.p > 0 ? 0 : 1;
      G.s[w]++; G.w = w;
      G.phase = G.s[w] >= WIN ? 'match' : 'round';
      clearTimeout(goTimer);
      sync(true);
      if (G.phase === 'round') timer = setTimeout(startRound, 1800);
    } else sync();
  }
  function again() { if (G.phase === 'match') startMatch(); }

  // Envio ao convidado limitado (~25/s) para não sobrecarregar a conexão; o último estado sempre chega
  let sendT = null, dirty = false;
  function netSend() {
    if (!(mode === 'host' && conn && conn.open)) return;
    if (sendT) { dirty = true; return; }
    conn.send({ t: 's', G });
    sendT = setTimeout(() => { sendT = null; if (dirty) { dirty = false; netSend(); } }, 40);
  }
  function sync() {
    render();
    netSend();
  }

  /* ---------------- Desenho ---------------- */
  function who(w) {
    if (mode === 'local') return w === 0 ? 'Vermelho' : 'Azul';
    return w === myIdx ? 'Você' : 'Oponente';
  }
  function render() {
    const me = mode === 'guest' ? myIdx : 0;
    app.dataset.me = me;
    app.dataset.mode = mode || '';
    app.classList.toggle('live', G.phase === 'play');
    app.style.setProperty('--v', me === 0 ? G.p : -G.p);
    $('#sMe').textContent = G.s[me];
    $('#sOpp').textContent = G.s[1 - me];

    const nm = idx => mode === 'local' ? (idx === 0 ? 'VERMELHO' : 'AZUL') : (idx === me ? 'VOCÊ' : 'OPONENTE');
    $('#nameMe').textContent = nm(me);
    $('#nameOpp').textContent = nm(1 - me);
    $('#kbdMe').textContent = 'Teclado: K e L (ou ← →), alternando';
    $('#kbdOpp').textContent = 'Teclado: A e S, alternando';

    let text = '', small = false, btns = false;
    if (G.phase === 'count') text = G.count;
    else if (G.phase === 'play' && G.go) text = 'VAI!';
    else if (G.phase === 'round') { text = who(G.w) + ' marcou!'; small = true; }
    else if (G.phase === 'match') {
      text = mode === 'local' ? who(G.w) + ' venceu! 🏆' : (G.w === me ? 'Você venceu! 🏆' : 'Você perdeu');
      small = true; btns = true;
    } else if (G.phase === 'idle' && mode === 'guest') { text = 'Conectando…'; small = true; }

    $('#overlay').classList.toggle('hidden', !text);
    const ov = $('#ovText');
    ov.textContent = text; ov.classList.toggle('sm', small);
    $('#ovBtns').classList.toggle('hidden', !btns);

    // Online: só a minha zona é controlável
    zones.opp.classList.toggle('off', mode !== 'local');
    if (G.phase !== 'play') Object.values(zones).forEach(z => z.classList.remove('drag'));
  }

  /* ---------------- Entrada ---------------- */
  // Guarda os "puxões" do convidado e envia em pequenos lotes
  let queued = 0, qTimer = null;
  function queuePull(a) {
    queued += a;
    if (qTimer) return;
    qTimer = setTimeout(() => {
      qTimer = null;
      if (queued > 0 && conn && conn.open) conn.send({ t: 'pull', a: queued });
      queued = 0;
    }, 35);
  }

  // side: 'me' (zona de baixo / da esquerda) ou 'opp' (zona de cima / da direita); a = quanto puxar
  function act(side, a) {
    if (G.phase !== 'play' || !(a > 0)) return;
    if (mode === 'local') pull(side === 'me' ? 0 : 1, a);
    else if (mode === 'host') { if (side === 'me') pull(0, a); }
    else if (mode === 'guest') { if (side === 'me') queuePull(a); }
  }

  // Direção em que cada zona "puxa" (rumo ao próprio jogador)
  function pullDir(side) {
    return isLand()
      ? { ax: 'x', s: side === 'me' ? -1 : 1 }   // horizontal: eu à esquerda, adversário à direita
      : { ax: 'y', s: side === 'me' ? 1 : -1 };  // retrato: eu embaixo, adversário em cima
  }

  // Controle principal: ARRASTAR em direção ao seu lado (dedo ou mouse; vários toques ao mesmo tempo)
  function bindZone(side) {
    const el = zones[side], knob = el.querySelector('.knob');
    const pts = new Map();
    function moveKnob(e) {
      const r = el.getBoundingClientRect();
      const x = Math.max(0, Math.min(r.width, e.clientX - r.left));
      const y = Math.max(0, Math.min(r.height, e.clientY - r.top));
      knob.style.transform = 'translate(' + x + 'px,' + y + 'px) translate(-50%,-50%)';
    }
    function end(e) {
      pts.delete(e.pointerId);
      if (!pts.size) el.classList.remove('drag');
    }
    el.addEventListener('pointerdown', e => {
      if (el.classList.contains('off')) return;
      e.preventDefault();
      try { el.setPointerCapture(e.pointerId); } catch (x) {}
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      el.classList.add('drag');
      moveKnob(e);
    });
    el.addEventListener('pointermove', e => {
      const last = pts.get(e.pointerId);
      if (!last) return;
      const { ax, s } = pullDir(side);
      const r = el.getBoundingClientRect();
      const len = ax === 'x' ? r.width : r.height;
      const d = (ax === 'x' ? e.clientX - last.x : e.clientY - last.y) * s;
      last.x = e.clientX; last.y = e.clientY;
      moveKnob(e);
      if (d > 0 && len > 0) act(side, Math.min(MAX_EVT, d / len * SWIPE_K));
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(ev => el.addEventListener(ev, end));
  }
  bindZone('me');
  bindZone('opp');
  window.addEventListener('blur', () => Object.values(zones).forEach(z => z.classList.remove('drag')));

  // Controle alternativo (teclado): alternar duas teclas, como "mão esquerda / mão direita".
  // Repetir a mesma tecla puxa bem menos — apertar sem ritmo não adianta.
  const lastHand = { me: null, opp: null };
  function keyPull(side, hand) {
    const full = lastHand[side] !== hand;
    lastHand[side] = hand;
    act(side, full ? KEY_STEP : KEY_STEP * 0.25);
  }
  document.addEventListener('keydown', e => {
    if (e.repeat || $('#game').classList.contains('hidden')) return;
    const k = e.key.toLowerCase();
    const HAND = { k: 0, l: 1, arrowleft: 0, arrowright: 1 };
    const HAND_OPP = { a: 0, s: 1 };
    if (mode === 'local') {
      if (k in HAND_OPP) { e.preventDefault(); keyPull('opp', HAND_OPP[k]); }
      else if (k in HAND) { e.preventDefault(); keyPull('me', HAND[k]); }
    } else {
      const h = k in HAND ? HAND[k] : (k in HAND_OPP ? HAND_OPP[k] : -1);
      if (h >= 0) { e.preventDefault(); keyPull('me', h); }
    }
  });

  /* ---------------- Online (PeerJS: salas por código) ---------------- */
  function genCode() {
    let c = '';
    for (let i = 0; i < 4; i++) c += LETTERS[Math.floor(Math.random() * LETTERS.length)];
    return c;
  }
  function needPeer() {
    if (typeof Peer === 'undefined') { setStatus('Não foi possível carregar a biblioteca online. Verifique sua internet.'); return false; }
    return true;
  }

  function createRoom() {
    if (!needPeer()) return;
    setStatus('Criando sala…');
    const code = genCode();
    peer = new Peer(PREFIX + code, PEER_OPTS); keepSignal(peer);
    peer.on('open', () => {
      mode = 'host'; myIdx = 0;
      $('#roomCode').textContent = code;
      $('#lobbyChoose').classList.add('hidden');
      $('#lobbyWait').classList.remove('hidden');
      setStatus('');
    });
    peer.on('connection', c => {
      if (conn && conn.open) { c.close(); return; }   // sala cheia (2 jogadores)
      conn = c; watchIce(c);
      c.on('open', () => { show('game'); startMatch(); keepAwake(); });
      c.on('data', onData);
      c.on('close', () => leave('O outro jogador saiu da sala.'));
    });
    peer.on('error', e => {
      if (e.type === 'unavailable-id') { try { peer.destroy(); } catch (x) {} createRoom(); }
      else setStatus('Erro de conexão (' + e.type + '). Tente novamente.');
    });
  }

  function joinRoom() {
    const code = $('#codeInput').value.trim().toUpperCase();
    if (code.length !== 4) { setStatus('Digite o código de 4 letras.'); return; }
    if (!needPeer()) return;
    setStatus('Entrando na sala…');
    peer = new Peer(undefined, PEER_OPTS); keepSignal(peer);
    peer.on('open', () => {
      conn = peer.connect(PREFIX + code, { reliable: true }); watchIce(conn);
      mode = 'guest'; myIdx = 1;
      joinTimer = setTimeout(() => leave('Não foi possível conectar. Confira o código e a internet dos dois aparelhos.'), 15000);
      conn.on('open', () => { clearTimeout(joinTimer); G = fresh(); show('game'); render(); keepAwake(); startPing(); });
      conn.on('data', onData);
      conn.on('close', () => leave('A sala foi encerrada.'));
    });
    peer.on('error', e => {
      setStatus(e.type === 'peer-unavailable' ? 'Sala não encontrada. Confira o código.' : 'Erro de conexão (' + e.type + ').');
    });
  }

  /* Latência: o convidado envia 'ping', o anfitrião responde 'pong' */
  let pingT = null;
  function startPing() {
    clearInterval(pingT); $('#ping').classList.remove('hidden');
    pingT = setInterval(() => { if (conn && conn.open) conn.send({ t: 'ping', at: performance.now() }); }, 2000);
  }
  function showPing(ms) {
    const el = $('#ping'); $('#pingMs').textContent = Math.round(ms) + ' ms';
    el.dataset.q = ms < 80 ? 'good' : ms < 200 ? 'mid' : 'bad';
  }
  // Se o servidor de sinalização cair, reconecta sem derrubar a partida em andamento
  function keepSignal(p) { p.on('disconnected', () => { try { if (!p.destroyed) p.reconnect(); } catch (e) {} }); }
  function watchIce(c) {
    const pc = c.peerConnection; if (!pc) return;
    pc.addEventListener('iceconnectionstatechange', () => {
      if (pc.iceConnectionState === 'failed') leave('A conexão entre os aparelhos falhou. Tente criar a sala de novo (ou troque de Wi-Fi/4G).');
    });
  }

  function onData(d) {
    if (!d) return;
    if (d.t === 'ping' && mode === 'host') { conn.send({ t: 'pong', at: d.at }); return; }
    if (d.t === 'pong' && mode === 'guest') { showPing(performance.now() - d.at); return; }
    if (mode === 'guest' && d.t === 's') { G = d.G; render(); }
    else if (mode === 'host') {
      if (d.t === 'pull') {
        const a = Number(d.a);
        if (isFinite(a) && a > 0) pull(1, Math.min(a, 0.25));
      } else if (d.t === 'again') again();
    }
  }

  /* ---------------- Botões ---------------- */
  $('#btnLocal').onclick = () => { mode = 'local'; myIdx = 0; show('game'); startMatch(); keepAwake(); };
  $('#btnOnline').onclick = () => { setStatus(''); show('online'); };
  $('#btnBackMenu').onclick = () => leave();
  $('#btnCreate').onclick = createRoom;
  $('#btnJoin').onclick = joinRoom;
  $('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') joinRoom(); });
  $('#btnCopy').onclick = () => {
    const c = $('#roomCode').textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(c) : Promise.reject())
      .then(() => setStatus('Código copiado!'), () => setStatus('Anote o código: ' + c));
  };
  const inviteUrl = () => location.origin + location.pathname + '?sala=' + $('#roomCode').textContent;
  $('#btnShare').onclick = () => {
    const url = inviteUrl();
    if (navigator.share) navigator.share({ title: 'Guerra de Cordas', text: 'Venha jogar comigo!', url }).catch(() => {});
    else (navigator.clipboard ? navigator.clipboard.writeText(url) : Promise.reject())
      .then(() => setStatus('Link copiado! Envie para o amigo.'), () => setStatus('Envie este link: ' + url));
  };
  $('#btnClose').onclick = () => leave();
  $('#btnMenu').onclick = () => leave();
  $('#btnAgain').onclick = () => {
    if (mode === 'guest') { if (conn && conn.open) conn.send({ t: 'again' }); }
    else again();
  };

  // Evita menu de contexto (toque longo) e fecha a conexão ao sair da página
  document.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('pagehide', () => { try { conn && conn.close(); peer && peer.destroy(); } catch (e) {} });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && mode) keepAwake(); });

  show('menu');
  // Abriu pelo link de convite (?sala=ABCD): entra direto na sala
  const qs = new URLSearchParams(location.search).get('sala');
  if (qs && /^[A-Za-z]{4}$/.test(qs)) {
    show('online'); $('#codeInput').value = qs.toUpperCase();
    window.addEventListener('load', joinRoom);
  }
})();
