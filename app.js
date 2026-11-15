/* Meeting Copilot Mobile - UI, microphone, Gemini. Pure logic lives in logic.js. */
(() => {
  'use strict';

  const API = 'https://generativelanguage.googleapis.com/v1beta';
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => Array.from(document.querySelectorAll(s));

  /* ---------- storage ---------- */
  function load(k, d) {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; }
  }
  function save(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* storage full or blocked */ }
  }

  const DEFAULTS = {
    apiKey: '', model: 'gemini-2.5-flash', speechLang: 'en-US', answerLang: 'english',
    maxWords: 60, auto: true, wake: true,
  };
  let settings = Object.assign({}, DEFAULTS, load('mc.settings', {}));
  let brief = Object.assign(
    { title: '', otherSide: '', role: '', goal: '', background: '', terms: '' }, load('mc.brief', {}),
  );
  let meetings = load('mc.meetings', []);

  function newMeeting() {
    return {
      id: Date.now().toString(36), title: brief.title || 'Meeting', startedAt: Date.now(),
      turns: [], answers: [], notes: '', summary: null,
    };
  }
  let meeting = meetings.find((m) => m.id === load('mc.current', null)) || newMeeting();

  function saveMeeting() {
    const hasContent = meeting.turns.length || meeting.notes || meeting.summary;
    if (hasContent) {
      const i = meetings.findIndex((m) => m.id === meeting.id);
      if (i >= 0) meetings[i] = meeting; else meetings.push(meeting);
      meetings.sort((a, b) => b.startedAt - a.startedAt);
      if (meetings.length > 30) meetings.length = 30;
      save('mc.meetings', meetings);
    }
    save('mc.current', meeting.id);
  }

  /* ---------- tiny helpers ---------- */
  function el(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of kids) e.append(c);
    return e;
  }
  function appError(msg) { const e = new Error(msg); e.app = true; return e; }

  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) { /* fall back */ }
    try {
      const ta = el('textarea', { style: 'position:fixed;opacity:0' });
      ta.value = text; document.body.append(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); return ok;
    } catch (e) { return false; }
  }

  let bannerTimer = null;
  function showBanner(msg, o) {
    const opts = o || {};
    const b = $('#banner');
    b.textContent = msg;
    b.className = 'banner' + (opts.info ? ' info' : '');
    if (opts.action) b.append(el('button', { class: 'ghost small', type: 'button', onclick: opts.action.fn, text: opts.action.label }));
    b.hidden = false;
    clearTimeout(bannerTimer);
    if (opts.autoHide) bannerTimer = setTimeout(hideBanner, opts.autoHide);
  }
  function hideBanner() { $('#banner').hidden = true; }

  /* ---------- tabs ---------- */
  function switchTab(name) {
    $$('.tab').forEach((s) => s.classList.toggle('active', s.id === 'tab-' + name));
    $$('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
    $('#dock').classList.toggle('hidden', name !== 'live');
    if (name === 'notes') renderNotes();
    window.scrollTo(0, 0);
  }
  $$('.nav button').forEach((b) => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  /* ---------- status ---------- */
  let listening = false;
  let thinking = false;
  let whoMode = 'them';

  function updateStatus() {
    const s = $('#status');
    if (thinking) { s.textContent = 'Thinking...'; s.className = 'chip busy'; }
    else if (listening) { s.textContent = whoMode === 'me' ? 'Listening (me)' : 'Listening'; s.className = 'chip live'; }
    else { s.textContent = 'Idle'; s.className = 'chip'; }
    const bl = $('#btnListen');
    bl.textContent = listening ? 'Stop listening' : 'Start listening';
    bl.classList.toggle('stop', listening);
  }

  /* ---------- Gemini ---------- */
  async function errMessage(res) {
    try { const j = await res.json(); return (j.error && j.error.message) || ''; } catch (e) { return ''; }
  }

  async function readStream(res, onText) {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    let full = '';
    const eat = (chunkText) => {
      const p = MC.parseSSE(chunkText);
      if (p.error) throw appError(p.error);
      if (p.texts.length) { full += p.texts.join(''); onText(full); }
      return p.rest;
    };
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf = eat(buf + dec.decode(value, { stream: true }));
    }
    eat(buf + '\n\n');
    if (!full.trim()) throw appError('Gemini sent an empty answer. Press "Write again".');
    return full;
  }

  async function readJson(res) {
    const j = await res.json();
    const c = j.candidates && j.candidates[0];
    const text = c && c.content && c.content.parts ? c.content.parts.map((p) => p.text || '').join('') : '';
    if (!text.trim()) {
      const block = j.promptFeedback && j.promptFeedback.blockReason;
      throw appError(block ? 'Gemini blocked this request: ' + block : 'Gemini sent an empty answer.');
    }
    return text;
  }

  async function gemini(o) {
    const key = String(settings.apiKey || '').trim();
    if (!key) throw appError('Add your Gemini API key in Settings first.');
    const model = String(settings.model || DEFAULTS.model).trim();
    const gen = { temperature: o.temperature != null ? o.temperature : 0.5, maxOutputTokens: o.maxTokens || 1024 };
    if (o.json) gen.responseMimeType = 'application/json';
    // Thinking adds seconds of silence in a live call; turn it off where the model allows it.
    if (/gemini-2\.5-flash/.test(model)) gen.thinkingConfig = { thinkingBudget: 0 };
    const stream = !!o.onText;
    const url = `${API}/models/${encodeURIComponent(model)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;

    for (let attempt = 0; attempt < 2; attempt++) {
      const body = {
        systemInstruction: { parts: [{ text: o.system }] },
        contents: [{ role: 'user', parts: [{ text: o.user }] }],
        generationConfig: gen,
      };
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: o.signal,
        });
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        throw appError('Cannot reach Gemini. Check your internet connection.');
      }
      if (!res.ok) {
        const msg = await errMessage(res);
        if (res.status === 400 && gen.thinkingConfig && /thinking/i.test(msg)) { delete gen.thinkingConfig; continue; }
        throw appError(MC.explainError(res.status, msg));
      }
      return stream ? readStream(res, o.onText) : readJson(res);
    }
    throw appError('Request failed.');
  }

  /* ---------- answers ---------- */
  let answerCtl = null;
  let lastQuestion = null;
  let lastAnswerText = '';

  function renderAnswer(raw, state) {
    const box = $('#answerText');
    box.classList.remove('placeholder', 'dim', 'err');
    const sp = MC.splitAnswer(raw);
    if (!raw && state === 'streaming') {
      box.textContent = 'Writing...'; box.classList.add('dim');
    } else if (!sp.answer && state === 'done') {
      box.textContent = 'No answer needed for that.'; box.classList.add('dim');
    } else {
      box.textContent = sp.answer;
    }
    lastAnswerText = sp.answer;
    const list = $('#nextList');
    list.textContent = '';
    sp.next.forEach((q) => list.append(el('li', { text: q })));
    $('#nextWrap').hidden = !sp.next.length;
  }

  function showAnswerError(msg) {
    const box = $('#answerText');
    box.classList.remove('placeholder', 'dim');
    box.classList.add('err');
    box.textContent = msg;
    $('#nextWrap').hidden = true;
  }

  function briefForPrompt() {
    return Object.assign({}, brief, { title: brief.title || meeting.title });
  }

  async function answer(question, opts) {
    const o = opts || {};
    const q = String(question || '').trim();
    if (!q) return;
    if (!String(settings.apiKey || '').trim()) {
      showBanner('Add your Gemini API key in Settings first.', { action: { label: 'Open Settings', fn: () => switchTab('settings') } });
      return;
    }
    hideBanner();
    if (answerCtl) answerCtl.abort();
    const ctl = new AbortController();
    answerCtl = ctl;
    lastQuestion = { text: q, opts: o };
    thinking = true; updateStatus();
    renderAnswer('', 'streaming');

    const end = meeting.turns.length - (o.skipLast || 0);
    const hist = meeting.turns.slice(Math.max(0, end - 14), Math.max(0, end));
    const prev = meeting.answers.slice(-2).map((a) => a.a).filter(Boolean);
    const system = MC.buildSystem(briefForPrompt(), settings);
    const user = MC.buildUserPrompt(q, hist, prev, { typed: o.typed, fresh: o.fresh });

    try {
      const full = await gemini({
        system, user, signal: ctl.signal, maxTokens: 1024, temperature: 0.5,
        onText: (t) => { if (ctl === answerCtl) renderAnswer(t, 'streaming'); },
      });
      if (ctl !== answerCtl) return;
      renderAnswer(full, 'done');
      const sp = MC.splitAnswer(full);
      if (sp.answer) {
        meeting.answers.push({ q, a: sp.answer, next: sp.next, ts: Date.now() });
        saveMeeting();
      }
    } catch (e) {
      if (e.name === 'AbortError') return;
      showAnswerError(e.app ? e.message : 'Something went wrong: ' + e.message);
    } finally {
      if (ctl === answerCtl) { thinking = false; answerCtl = null; updateStatus(); }
    }
  }

  /* ---------- turn buffer: wait until they have really finished ---------- */
  const buf = { pending: [], startedAt: 0, lastActivity: 0, timer: null };

  function noteActivity() { buf.lastActivity = Date.now(); }
  function resetBuf() { clearTimeout(buf.timer); buf.pending = []; buf.startedAt = 0; }
  function scheduleTick() { clearTimeout(buf.timer); buf.timer = setTimeout(tick, 150); }

  function pushThem(text) {
    buf.pending.push(text);
    if (!buf.startedAt) buf.startedAt = Date.now();
    noteActivity();
    scheduleTick();
  }

  function tick() {
    if (!buf.pending.length) return;
    const now = Date.now();
    const joined = buf.pending.join(' ');
    const complete = MC.isSubstantive(joined, settings.speechLang);
    const quiet = now - buf.lastActivity;
    const waited = now - buf.startedAt;
    const need = complete ? 500 : 1800;
    if (waited >= 25000 || quiet >= need || (!complete && quiet >= 6000)) { flushBuf(); return; }
    scheduleTick();
  }

  function flushBuf() {
    if (!buf.pending.length) return;
    const text = buf.pending.join(' ').replace(/\s+/g, ' ').trim();
    const parts = buf.pending.length;
    resetBuf();
    if (settings.auto && MC.needsAnswer(text, settings.speechLang)) answer(text, { skipLast: parts });
  }

  /* ---------- microphone ---------- */
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  let rec = null;
  let recRunning = false;
  let lastFinal = { text: '', at: 0 };
  let errStreak = 0;
  let wakeLock = null;

  function addTurn(who, text) {
    meeting.turns.push({ who, text, ts: Date.now() });
    saveMeeting();
    renderTranscript();
  }

  function renderTranscript() {
    const box = $('#transcript');
    box.textContent = '';
    const offset = Math.max(0, meeting.turns.length - 40);
    meeting.turns.slice(offset).forEach((t, i) => {
      const idx = offset + i;
      box.append(el('div', { class: 'line ' + t.who, onclick: () => toggleWho(idx) },
        el('span', { class: 'who', text: t.who === 'me' ? 'ME' : 'THEM' }), t.text));
    });
    box.scrollTop = box.scrollHeight;
  }

  function toggleWho(idx) {
    const t = meeting.turns[idx];
    if (!t) return;
    t.who = t.who === 'me' ? 'them' : 'me';
    saveMeeting();
    renderTranscript();
  }

  function beginRecognition() {
    if (!listening || recRunning) return;
    rec = new SR();
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    rec.lang = settings.speechLang || 'en-US';
    lastFinal = { text: '', at: 0 };

    rec.onstart = () => { recRunning = true; };
    rec.onresult = (e) => {
      errStreak = 0;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        const txt = String(r[0].transcript || '').trim();
        if (!txt) continue;
        if (r.isFinal) {
          const now = Date.now();
          const clean = MC.dedupeFinal(lastFinal.text, txt, now - lastFinal.at);
          lastFinal = { text: txt, at: now };
          if (clean) {
            addTurn(whoMode, clean);
            if (whoMode === 'them') pushThem(clean);
          }
        } else {
          interim += (interim ? ' ' : '') + txt;
        }
      }
      $('#interim').textContent = interim;
      if (interim && whoMode === 'them') noteActivity();
    };
    rec.onerror = (e) => {
      const code = e.error;
      if (code === 'not-allowed' || code === 'service-not-allowed') {
        stopListening();
        showBanner('Microphone is blocked. Allow the microphone for this site in the browser settings, then try again.');
      } else if (code === 'language-not-supported') {
        stopListening();
        showBanner('This browser cannot listen in that language. Pick another one in Settings.');
      } else if (code === 'audio-capture') {
        errStreak++;
        if (errStreak >= 3) {
          stopListening();
          showBanner('The microphone is not available. Another app, such as a phone call, may be using it.');
        }
      } else if (code === 'network') {
        showBanner("Can't reach the speech service. Check your internet connection.", { info: true, autoHide: 4000 });
      }
    };
    rec.onend = () => {
      recRunning = false;
      $('#interim').textContent = '';
      if (listening) setTimeout(beginRecognition, errStreak ? 1000 : 250);
    };
    try { rec.start(); } catch (e) { recRunning = false; }
  }

  async function takeWake() {
    if (!settings.wake || !('wakeLock' in navigator)) return;
    try {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) { /* not allowed right now */ }
  }
  function dropWake() { try { if (wakeLock) wakeLock.release(); } catch (e) { /* ignore */ } wakeLock = null; }

  function startListening() {
    if (!SR) {
      showBanner('This browser has no speech recognition. Open this page in Chrome on Android.');
      return;
    }
    if (!String(settings.apiKey || '').trim()) {
      showBanner('Add your Gemini API key in Settings first.', { action: { label: 'Open Settings', fn: () => switchTab('settings') } });
      return;
    }
    hideBanner();
    listening = true; errStreak = 0;
    updateStatus();
    takeWake();
    beginRecognition();
  }

  function stopListening() {
    listening = false;
    try { if (rec) rec.stop(); } catch (e) { /* ignore */ }
    dropWake();
    flushBuf();
    updateStatus();
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && listening) {
      takeWake();
      if (!recRunning) beginRecognition();
    }
  });

  /* ---------- Live tab wiring ---------- */
  $('#btnListen').addEventListener('click', () => (listening ? stopListening() : startListening()));

  $('#btnNow').addEventListener('click', () => {
    if (buf.pending.length) {
      const text = buf.pending.join(' ');
      const parts = buf.pending.length;
      resetBuf();
      answer(text, { forced: true, skipLast: parts });
      return;
    }
    const turns = meeting.turns;
    let i = turns.length - 1;
    while (i >= 0 && turns[i].who !== 'them') i--;
    if (i < 0) { showBanner('Nothing heard yet.', { info: true, autoHide: 2000 }); return; }
    let j = i;
    while (j > 0 && turns[j - 1].who === 'them' && i - j < 3) j--;
    const text = turns.slice(j, i + 1).map((t) => t.text).join(' ');
    answer(text, { forced: true, skipLast: turns.length - j });
  });

  $('#btnRewrite').addEventListener('click', () => {
    if (!lastQuestion) return;
    answer(lastQuestion.text, Object.assign({}, lastQuestion.opts, { fresh: true, forced: true }));
  });

  $('#btnCopy').addEventListener('click', async (ev) => {
    if (!lastAnswerText) return;
    const ok = await copyText(lastAnswerText);
    ev.target.textContent = ok ? 'Copied' : 'Copy failed';
    setTimeout(() => { ev.target.textContent = 'Copy'; }, 1200);
  });

  $$('#whoSeg button').forEach((b) => b.addEventListener('click', () => {
    whoMode = b.dataset.who;
    $$('#whoSeg button').forEach((x) => x.classList.toggle('on', x === b));
    if (whoMode === 'me') { flushBuf(); }
    updateStatus();
  }));

  function sendAsk() {
    const inp = $('#askInput');
    const t = inp.value.trim();
    if (!t) return;
    inp.value = '';
    answer(t, { typed: true, forced: true });
  }
  $('#btnAsk').addEventListener('click', sendAsk);
  $('#askInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAsk(); });

  /* ---------- Brief tab ---------- */
  const BRIEF_FIELDS = ['title', 'otherSide', 'role', 'goal', 'background', 'terms'];
  function fillBrief() { BRIEF_FIELDS.forEach((f) => { $('#b_' + f).value = brief[f] || ''; }); }
  BRIEF_FIELDS.forEach((f) => $('#b_' + f).addEventListener('input', (e) => {
    brief[f] = e.target.value;
    save('mc.brief', brief);
  }));

  $('#btnClarify').addEventListener('click', async (ev) => {
    const btn = ev.target;
    const box = $('#clarifyBox');
    box.textContent = '';
    btn.disabled = true; btn.textContent = 'Thinking...';
    try {
      const system = 'You help someone prepare for a meeting. Read their brief and return ONLY JSON like '
        + '{"questions":["..."]}: 4 to 6 short, specific questions whose answers (facts, prices, past results, '
        + 'limits, preferences) would most improve the answers they get live during the meeting. '
        + 'Never ask about anything the brief already says.';
      const user = MC.buildSystem(briefForPrompt(), settings).split('BRIEF FOR THIS MEETING')[1] || '(empty brief)';
      const text = await gemini({ system, user: 'BRIEF' + user, json: true, maxTokens: 600, temperature: 0.3 });
      const data = MC.parseJSON(text);
      const qs = data && Array.isArray(data.questions) ? data.questions.slice(0, 6) : [];
      if (!qs.length) throw appError('No questions came back. Try again.');
      const areas = [];
      qs.forEach((q) => {
        const ta = el('textarea', { rows: '2', placeholder: 'Your answer' });
        areas.push([q, ta]);
        box.append(el('div', { class: 'q' }, el('div', { class: 'qt', text: q }), ta));
      });
      box.append(el('button', {
        class: 'primary', type: 'button', style: 'margin-top:14px;width:100%',
        text: 'Add answers to my brief',
        onclick: () => {
          const add = areas.filter(([, ta]) => ta.value.trim()).map(([q, ta]) => `Q: ${q}\nA: ${ta.value.trim()}`);
          if (!add.length) return;
          brief.background = (brief.background ? brief.background.trim() + '\n\n' : '') + add.join('\n\n');
          save('mc.brief', brief); fillBrief(); box.textContent = '';
          showBanner('Added to your brief.', { info: true, autoHide: 2000 });
        },
      }));
    } catch (e) {
      box.append(el('div', { class: 'hint err', text: e.app ? e.message : 'Something went wrong: ' + e.message }));
    } finally {
      btn.disabled = false; btn.textContent = 'Ask me questions';
    }
  });

  /* ---------- Notes tab ---------- */
  const fmtDate = (ts) => new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });

  function renderSummary(s) {
    const box = $('#summaryBox');
    box.textContent = '';
    if (!s) return;
    const block = (title, node) => box.append(el('div', { class: 'sumBlock' }, el('h4', { text: title }), node));
    if (s.summary) block('SUMMARY', el('p', { text: s.summary }));
    if (Array.isArray(s.decisions) && s.decisions.length) {
      block('DECISIONS', el('ul', null, ...s.decisions.map((d) => el('li', { text: String(d) }))));
    }
    if (Array.isArray(s.actionItems) && s.actionItems.length) {
      block('ACTION ITEMS', el('ul', null, ...s.actionItems.map((a) => {
        const who = a.who ? a.who + ': ' : '';
        const when = a.when ? ' (' + a.when + ')' : '';
        return el('li', { text: who + (a.what || '') + when });
      })));
    }
    if (s.followUp) block('FOLLOW-UP MESSAGE', el('p', { text: s.followUp }));
  }

  function renderHistory() {
    const box = $('#history');
    box.textContent = '';
    if (!meetings.length) { box.append(el('div', { class: 'hint', text: 'Meetings you record are saved here.' })); return; }
    meetings.forEach((m) => {
      box.append(el('div', { class: 'hist' },
        el('div', { onclick: () => openMeeting(m.id) },
          el('div', { class: 't', text: m.title || 'Meeting' }),
          el('div', { class: 'd', text: fmtDate(m.startedAt) + ' - ' + m.turns.length + ' lines' })),
        el('button', {
          class: 'ghost small danger', type: 'button', text: 'Delete',
          onclick: () => deleteMeeting(m.id),
        })));
    });
  }

  function renderNotes() {
    $('#meetingMeta').textContent = `${meeting.title || 'Meeting'} - ${fmtDate(meeting.startedAt)} - ${meeting.turns.length} lines`;
    $('#n_notes').value = meeting.notes || '';
    renderSummary(meeting.summary);
    renderHistory();
  }

  function openMeeting(id) {
    const m = meetings.find((x) => x.id === id);
    if (!m) return;
    meeting = m; save('mc.current', m.id);
    renderTranscript(); renderNotes();
    $('#answerText').className = 'answerText placeholder';
    $('#answerText').textContent = 'Press Start listening. When the other person asks something, your answer appears here.';
    $('#nextWrap').hidden = true;
    window.scrollTo(0, 0);
  }

  function deleteMeeting(id) {
    if (!confirm('Delete this meeting from the phone?')) return;
    meetings = meetings.filter((m) => m.id !== id);
    save('mc.meetings', meetings);
    if (meeting.id === id) { meeting = newMeeting(); save('mc.current', meeting.id); renderTranscript(); }
    renderNotes();
  }

  $('#n_notes').addEventListener('input', (e) => { meeting.notes = e.target.value; saveMeeting(); });

  $('#btnNew').addEventListener('click', () => {
    if (listening && !confirm('You are still listening. Start a new meeting anyway?')) return;
    if (answerCtl) answerCtl.abort();
    resetBuf();
    meeting = newMeeting(); save('mc.current', meeting.id);
    lastQuestion = null; lastAnswerText = '';
    renderTranscript(); renderNotes();
    $('#answerText').className = 'answerText placeholder';
    $('#answerText').textContent = 'New meeting started.';
    $('#nextWrap').hidden = true;
  });

  function transcriptText() {
    return meeting.turns.map((t) => (t.who === 'me' ? 'Me: ' : 'Them: ') + t.text).join('\n');
  }

  $('#btnSummary').addEventListener('click', async (ev) => {
    const btn = ev.target;
    if (!meeting.turns.length && !meeting.notes) {
      showBanner('Nothing to summarise yet. Record a meeting or write notes first.', { info: true, autoHide: 3000 });
      return;
    }
    btn.disabled = true; btn.textContent = 'Writing summary...';
    try {
      const system = 'You write meeting notes. Return ONLY JSON: {"summary":"3-5 plain sentences",'
        + '"decisions":["..."],"actionItems":[{"who":"","what":"","when":""}],'
        + '"followUp":"a short, friendly message my person could send to the other side"}. '
        + 'Use only what is in the transcript and notes; never invent decisions, names, or dates. '
        + 'Leave a list empty if there is nothing. "Me" is my person, "Them" is the other side. '
        + 'The transcript comes from speech recognition and can contain mistakes.';
      const user = `Meeting: ${meeting.title}\nGoal: ${brief.goal || '(not given)'}\n\nTRANSCRIPT\n${transcriptText() || '(none)'}\n\nMY NOTES\n${meeting.notes || '(none)'}`;
      const text = await gemini({ system, user, json: true, maxTokens: 1500, temperature: 0.3 });
      const data = MC.parseJSON(text);
      if (!data) throw appError('The summary came back in a format I could not read. Try again.');
      meeting.summary = data; saveMeeting(); renderSummary(data);
    } catch (e) {
      $('#summaryBox').textContent = '';
      $('#summaryBox').append(el('div', { class: 'hint err', text: e.app ? e.message : 'Something went wrong: ' + e.message }));
    } finally {
      btn.disabled = false; btn.textContent = 'Generate summary';
    }
  });

  function exportText() {
    const s = meeting.summary;
    const out = [`${meeting.title || 'Meeting'}`, fmtDate(meeting.startedAt), ''];
    if (s) {
      if (s.summary) out.push('SUMMARY', s.summary, '');
      if (s.decisions && s.decisions.length) out.push('DECISIONS', ...s.decisions.map((d) => '- ' + d), '');
      if (s.actionItems && s.actionItems.length) {
        out.push('ACTION ITEMS', ...s.actionItems.map((a) => `- ${a.who ? a.who + ': ' : ''}${a.what || ''}${a.when ? ' (' + a.when + ')' : ''}`), '');
      }
      if (s.followUp) out.push('FOLLOW-UP MESSAGE', s.followUp, '');
    }
    if (meeting.notes) out.push('MY NOTES', meeting.notes, '');
    out.push('TRANSCRIPT', transcriptText() || '(none)');
    return out.join('\n');
  }

  $('#btnCopyAll').addEventListener('click', async () => {
    const ok = await copyText(exportText());
    showBanner(ok ? 'Copied.' : 'Could not copy.', { info: true, autoHide: 1500 });
  });
  $('#btnShare').addEventListener('click', async () => {
    const text = exportText();
    if (navigator.share) { try { await navigator.share({ title: meeting.title || 'Meeting', text }); } catch (e) { /* cancelled */ } }
    else { const ok = await copyText(text); showBanner(ok ? 'Sharing is not available here, so it was copied.' : 'Could not share.', { info: true, autoHide: 2500 }); }
  });
  $('#btnDownload').addEventListener('click', () => {
    const blob = new Blob([exportText()], { type: 'text/plain' });
    const a = el('a', { href: URL.createObjectURL(blob), download: (meeting.title || 'meeting').replace(/[^\w\- ]+/g, '').trim() + '.txt' });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  });

  /* ---------- Settings tab ---------- */
  function fillSettings() {
    $('#s_key').value = settings.apiKey;
    $('#s_model').value = settings.model;
    $('#s_speechLang').value = settings.speechLang;
    $('#s_answerLang').value = settings.answerLang;
    $('#s_maxWords').value = settings.maxWords;
    $('#s_auto').checked = !!settings.auto;
    $('#s_wake').checked = !!settings.wake;
  }
  function bindSetting(id, key, read) {
    $(id).addEventListener('change', (e) => { settings[key] = read(e.target); save('mc.settings', settings); });
  }
  bindSetting('#s_model', 'model', (t) => t.value.trim() || DEFAULTS.model);
  bindSetting('#s_speechLang', 'speechLang', (t) => t.value);
  bindSetting('#s_answerLang', 'answerLang', (t) => t.value);
  bindSetting('#s_maxWords', 'maxWords', (t) => Math.min(150, Math.max(20, Number(t.value) || 60)));
  bindSetting('#s_auto', 'auto', (t) => t.checked);
  bindSetting('#s_wake', 'wake', (t) => t.checked);
  $('#s_key').addEventListener('input', (e) => { settings.apiKey = e.target.value.trim(); save('mc.settings', settings); });

  $('#btnShowKey').addEventListener('click', (e) => {
    const k = $('#s_key');
    k.type = k.type === 'password' ? 'text' : 'password';
    e.target.textContent = k.type === 'password' ? 'Show' : 'Hide';
  });

  $('#btnTest').addEventListener('click', async (ev) => {
    const out = $('#testResult');
    const btn = ev.target;
    out.className = 'hint'; out.textContent = '';
    const key = String(settings.apiKey || '').trim();
    if (!key) { out.className = 'hint err'; out.textContent = 'Paste your key first.'; return; }
    btn.disabled = true; btn.textContent = 'Testing...';
    try {
      const res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
      if (!res.ok) throw appError(MC.explainError(res.status, await errMessage(res)));
      const j = await res.json();
      const names = (j.models || [])
        .filter((m) => /gemini/i.test(m.name) && (m.supportedGenerationMethods || []).includes('generateContent'))
        .map((m) => m.name.replace(/^models\//, ''));
      const dl = $('#modelList');
      dl.textContent = '';
      names.forEach((n) => dl.append(el('option', { value: n })));
      out.className = 'hint ok';
      out.textContent = `Key works. ${names.length} models available; tap the Model box to pick one.`;
      if (names.length && !names.includes(settings.model)) {
        out.className = 'hint err';
        out.textContent = `Key works, but the model "${settings.model}" is not in your list. Tap the Model box and pick one.`;
      }
    } catch (e) {
      out.className = 'hint err';
      out.textContent = e.app ? e.message : 'Cannot reach Gemini. Check your internet connection.';
    } finally {
      btn.disabled = false; btn.textContent = 'Test key';
    }
  });

  $('#btnWipe').addEventListener('click', () => {
    if (!confirm('Delete the key, briefs, transcripts and notes from this phone?')) return;
    try { localStorage.clear(); } catch (e) { /* ignore */ }
    location.reload();
  });

  /* ---------- boot ---------- */
  fillBrief(); fillSettings(); renderTranscript(); updateStatus();
  if (!SR) showBanner('Live listening needs Chrome on Android. You can still prepare a brief and write notes here.', { info: true });
  else if (!settings.apiKey) showBanner('Welcome. Add your Gemini API key in Settings to begin.', { info: true, action: { label: 'Open Settings', fn: () => switchTab('settings') } });

  if ('serviceWorker' in navigator && /^https?:$/.test(location.protocol)) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline shell is optional */ });
  }
})();
