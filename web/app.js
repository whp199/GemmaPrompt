/* MikuPrompt — client */

const $ = (s) => document.querySelector(s);
const LS = {
  settings: 'mikuprompt.settings',
  favs: 'mikuprompt.favourites',
  history: 'mikuprompt.history',
};

const state = {
  profiles: {},
  groups: [],
  current: null,
  artists: [],
  tags: [],
  negTags: [],
  images: [],
  favs: new Set(JSON.parse(localStorage.getItem(LS.favs) || '[]')),
  history: JSON.parse(localStorage.getItem(LS.history) || '[]'),
  settings: Object.assign(
    {
      backend: '',
      apiKey: '',
      model: '',
      temp: 0.85,
      maxTokens: 2048,
      thinking: 'off',
      prefill: '',
      sysMode: 'append',
      sysExtra: '',
    },
    JSON.parse(localStorage.getItem(LS.settings) || '{}')
  ),
  abort: null,
  raw: '',
  artistOffset: 0,
  artistQuery: '',
};

const saveSettings = () => localStorage.setItem(LS.settings, JSON.stringify(state.settings));
const saveFavs = () => localStorage.setItem(LS.favs, JSON.stringify([...state.favs]));
const saveHistory = () =>
  localStorage.setItem(LS.history, JSON.stringify(state.history.slice(0, 60)));

const esc = (s) =>
  String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));

let toastTimer;
function toast(msg, bad = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast' + (bad ? ' bad' : '');
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 2600);
}

/* ── miku, your prompt maid ─────────────────────────────────── */

const MOODS = {
  idle: '/img/miku-welcome.webp',
  thinking: '/img/miku-thinking.webp',
  happy: '/img/miku-cheer.webp',
  bow: '/img/miku-bow.webp',
};
let mikuMood = 'idle';

function miku(text, mood = 'idle', warn = false) {
  const bubble = $('#mikuSay');
  bubble.className = 'bubble' + (warn ? ' warn' : '');
  bubble.innerHTML = text;
  // restart the entrance animation so repeated lines still register
  bubble.style.animation = 'none';
  void bubble.offsetWidth;
  bubble.style.animation = '';

  if (mood !== mikuMood && MOODS[mood]) {
    mikuMood = mood;
    const img = $('#mikuImg');
    img.classList.add('swap');
    setTimeout(() => {
      img.src = MOODS[mood];
      img.classList.remove('swap');
    }, 200);
  }
}

/* ── profiles ───────────────────────────────────────────────── */

async function loadProfiles() {
  const data = await (await fetch('/api/profiles')).json();
  state.profiles = data.profiles;
  state.groups = data.groups;

  const list = $('#profileList');
  list.innerHTML = '';
  for (const group of data.groups) {
    const label = document.createElement('div');
    label.className = 'group-label';
    label.textContent = group.label;
    list.appendChild(label);

    for (const [id, p] of Object.entries(data.profiles)) {
      if (p.group !== group.id) continue;
      const btn = document.createElement('button');
      btn.className = 'profile';
      btn.dataset.id = id;
      btn.innerHTML = `<b>${esc(p.label)}</b><small>${esc(p.sub)}</small>`;
      btn.onclick = () => selectProfile(id);
      list.appendChild(btn);
    }
  }
  selectProfile(state.settings.profile && data.profiles[state.settings.profile] ? state.settings.profile : 'anima');
}

function selectProfile(id) {
  state.current = id;
  state.settings.profile = id;
  saveSettings();
  const p = state.profiles[id];

  document.querySelectorAll('.profile').forEach((b) => b.classList.toggle('on', b.dataset.id === id));
  $('#profileMeta').innerHTML =
    esc(p.meta || '') + (p.workflow ? `<span class="wf">▸ ${esc(p.workflow)}.json</span>` : '');

  $('#artistBlock').hidden = !p.artists;
  $('#tagBlock').hidden = !p.tagsets && p.dialect !== 'tags';
  $('#h3Block').hidden = p.family !== 'h3';
  $('#negWrap').hidden = !p.negative;
  $('#visionBlock').hidden = !p.vision;
  $('#visionBadge').textContent = p.visionRequired ? 'required' : 'vision';
  $('#visionBadge').className = p.visionRequired ? 'badge alt' : 'badge';

  if (p.temperature != null && !state.settings.tempTouched) {
    state.settings.temp = p.temperature;
    $('#temp').value = p.temperature;
    $('#tempOut').textContent = Number(p.temperature).toFixed(2);
  }
  if (p.maxTokens && !state.settings.tokensTouched) {
    state.settings.maxTokens = p.maxTokens;
    $('#maxTokens').value = p.maxTokens;
  }
  if (!p.negative) $('#optNegative').checked = false;
  renderChips();

  let line = p.miku || `I'll write for <b>${esc(p.label)}</b>.`;
  if (p.visionRequired) {
    line += ' <em>This one needs an image to work from.</em>';
  }
  miku(line, 'idle', !!p.visionRequired && !state.images.length);
}

/* ── chips ──────────────────────────────────────────────────── */

function renderChips() {
  const ac = $('#artistChips');
  if (!state.artists.length) {
    ac.innerHTML = '<span class="empty">none — booru artist tags are Anima\'s strongest style lever</span>';
  } else {
    ac.innerHTML = '';
    state.artists.forEach((a, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip artist';
      chip.innerHTML = `<span class="k">✎</span>${esc(a)}<button title="remove">✕</button>`;
      chip.querySelector('button').onclick = () => {
        state.artists.splice(i, 1);
        renderChips();
      };
      ac.appendChild(chip);
    });
  }

  const tc = $('#tagChips');
  const all = [...state.tags.map((t) => [t, false]), ...state.negTags.map((t) => [t, true])];
  if (!all.length) {
    tc.innerHTML = '<span class="empty">none selected</span>';
  } else {
    tc.innerHTML = '';
    all.forEach(([t, neg]) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.innerHTML = `<span class="k">${neg ? '−' : '#'}</span>${esc(t)}<button title="remove">✕</button>`;
      chip.querySelector('button').onclick = () => {
        const arr = neg ? state.negTags : state.tags;
        arr.splice(arr.indexOf(t), 1);
        renderChips();
        renderTagSets();
      };
      tc.appendChild(chip);
    });
  }
}

/* ── images ─────────────────────────────────────────────────── */

const MAX_EDGE = 1152;

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        // Downscale before base64 — a 4k screenshot is otherwise ~8MB of JSON
        // per request and slows the vision encoder down for no benefit.
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        if (scale === 1 && reader.result.length < 1.4e6) return resolve(reader.result);
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(img.width * scale);
        canvas.height = Math.round(img.height * scale);
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL('image/jpeg', 0.9));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function addFiles(files) {
  const p = state.profiles[state.current];
  if (p && !p.vision) return toast('this model profile has no vision use', true);
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    try {
      state.images.push(await fileToImage(file));
    } catch {
      toast('could not read ' + file.name, true);
    }
  }
  renderThumbs();
  if (state.images.length) {
    const n = state.images.length;
    miku(
      `Got ${n === 1 ? 'your image' : n + ' images'}. I'll look at ${n === 1 ? 'it' : 'them'} properly and build the prompt from what's actually there.`,
      'idle'
    );
  }
}

function renderThumbs() {
  const box = $('#thumbs');
  box.innerHTML = '';
  state.images.forEach((src, i) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    el.innerHTML = `<img src="${src}" alt=""><span class="n">${i + 1}</span><button class="x">✕</button>`;
    el.querySelector('.x').onclick = () => {
      state.images.splice(i, 1);
      renderThumbs();
    };
    box.appendChild(el);
  });
}

/* ── artist browser ─────────────────────────────────────────── */

let artistTab = 'all';
let searchTimer;

async function searchArtists(reset = true) {
  if (reset) state.artistOffset = 0;
  const box = $('#artistResults');

  if (artistTab === 'fav') {
    const favs = [...state.favs].filter((f) =>
      f.toLowerCase().includes(state.artistQuery.toLowerCase())
    );
    box.innerHTML = favs.length
      ? ''
      : '<div class="row-empty">no favourites yet — star an artist to keep it</div>';
    favs.forEach((name) => box.appendChild(artistRow({ name, count: null, aliases: [] })));
    $('#loadMoreArtists').hidden = true;
    return;
  }

  const url = `/api/artists?q=${encodeURIComponent(state.artistQuery)}&limit=80&offset=${state.artistOffset}`;
  const data = await (await fetch(url)).json();
  if (reset) box.innerHTML = '';
  if (!data.results.length && reset) {
    box.innerHTML = '<div class="row-empty">nothing matched</div>';
  }
  data.results.forEach((row) => box.appendChild(artistRow(row)));
  $('#loadMoreArtists').hidden = state.artistOffset + 80 >= data.total;
}

function artistRow(row) {
  const el = document.createElement('div');
  el.className = 'row';
  const fav = state.favs.has(row.name);
  const count = row.count != null ? row.count.toLocaleString() : '';
  const aliases = row.aliases && row.aliases.length ? `<span class="al">${esc(row.aliases.join(', '))}</span>` : '';
  el.innerHTML =
    `<button class="star ${fav ? 'on' : ''}" title="favourite">${fav ? '★' : '☆'}</button>` +
    `<span class="nm">${esc(row.name)}${aliases}</span>` +
    `<span class="ct">${count}</span>`;

  el.querySelector('.star').onclick = (ev) => {
    ev.stopPropagation();
    if (state.favs.has(row.name)) state.favs.delete(row.name);
    else state.favs.add(row.name);
    saveFavs();
    $('#favCount').textContent = state.favs.size;
    searchArtists(true);
  };
  el.onclick = () => {
    if (!state.artists.includes(row.name)) {
      state.artists.push(row.name);
      renderChips();
      el.classList.add('added');
      toast('added ' + row.name);
    }
  };
  return el;
}

/* ── tag browser ────────────────────────────────────────────── */

let tagSets = [];

async function loadTagSets() {
  tagSets = (await (await fetch('/api/tagsets')).json()).sets;
  renderTagSets();
}

function renderTagSets() {
  if ($('#tagSearch').value.trim()) return;
  const box = $('#tagResults');
  box.innerHTML = '';
  for (const set of tagSets) {
    const el = document.createElement('div');
    el.className = 'tagset' + (set.negative ? ' neg' : '');
    el.innerHTML =
      `<h4>${esc(set.label)}</h4>` +
      (set.hint ? `<p>${esc(set.hint)}</p>` : '') +
      '<div class="pool"></div>';
    const pool = el.querySelector('.pool');
    for (const tag of set.tags) {
      const arr = set.negative ? state.negTags : state.tags;
      const btn = document.createElement('button');
      btn.className = 'ptag' + (arr.includes(tag) ? ' on' : '');
      btn.textContent = tag;
      btn.onclick = () => {
        const list = set.negative ? state.negTags : state.tags;
        const at = list.indexOf(tag);
        if (at >= 0) list.splice(at, 1);
        else {
          if (set.exclusive) {
            for (const other of set.tags) {
              const idx = list.indexOf(other);
              if (idx >= 0) list.splice(idx, 1);
            }
          }
          list.push(tag);
        }
        renderChips();
        renderTagSets();
      };
      pool.appendChild(btn);
    }
    box.appendChild(el);
  }
}

async function searchTags() {
  const query = $('#tagSearch').value.trim();
  if (!query) return renderTagSets();
  const kind = $('#tagKind').value;
  const url = `/api/tags?q=${encodeURIComponent(query)}&kind=${kind}&limit=120`;
  const data = await (await fetch(url)).json();
  const box = $('#tagResults');
  box.innerHTML = data.results.length ? '' : '<div class="row-empty">nothing matched</div>';
  for (const row of data.results) {
    const el = document.createElement('div');
    el.className = 'row';
    const aliases = row.aliases.length ? `<span class="al">${esc(row.aliases.join(', '))}</span>` : '';
    el.innerHTML =
      `<span class="kd ${row.kind}">${row.kind.slice(0, 4)}</span>` +
      `<span class="nm">${esc(row.name)}${aliases}</span>` +
      `<span class="ct">${row.count.toLocaleString()}</span>`;
    el.onclick = () => {
      const name = row.name.replace(/_/g, ' ');
      const target = row.kind === 'artist' ? state.artists : state.tags;
      if (!target.includes(name)) {
        target.push(name);
        renderChips();
        el.classList.add('added');
        toast('added ' + name);
      }
    };
    box.appendChild(el);
  }
}

/* ── output rendering ───────────────────────────────────────── */

function paint(text) {
  let html = esc(text);
  html = html
    .replace(/^(subject_definitions|summary|retention_analysis|detailed_description|integrated_multimodal_description|overall_soundscape|non_diegetic_music):/gm,
      '<span class="sect">$1:</span>')
    .replace(/\[Shot \d+\]/g, '<span class="shot">$&</span>')
    .replace(/&lt;(Subject|Picture|Video|Audio) \d+&gt;/g, '<span class="lbl">$&</span>')
    .replace(/\(S\d+(?:,S\d+)*\)/g, '<span class="lbl">$&</span>')
    .replace(/&lt;d&gt;[\s\S]*?&lt;\/d&gt;/g, '<span class="dlg">$&</span>')
    .replace(/\b(fully_preserved|partially_preserved|attribute_transfer|weak_reference|fully_copy|partially_copy|reference)\b/g,
      '<span class="lbl">$1</span>');
  return html;
}

function renderOut() {
  const [main, neg] = splitNegative(state.raw);
  $('#out').innerHTML = paint(main) + (state.abort ? '<span class="cursor"></span>' : '');
  $('#negOut').hidden = !neg;
  if (neg) $('#negText').textContent = neg;
}

function splitNegative(text) {
  const match = text.match(/\n\s*NEGATIVE:\s*/i);
  if (!match) return [text, ''];
  return [text.slice(0, match.index).trim(), text.slice(match.index + match[0].length).trim()];
}

/* ── generate ───────────────────────────────────────────────── */

async function generate() {
  const idea = $('#idea').value.trim();
  const p = state.profiles[state.current];
  if (!idea && !state.images.length) {
    miku("Tell me what you'd like to see first — even something like <b>girl on a rooftop</b> is plenty to work with.", 'idle', true);
    return toast('describe an idea first', true);
  }
  if (p.visionRequired && !state.images.length) {
    miku(`<b>${esc(p.label)}</b> works from a picture. Drop one in the reference box and I'll take it from there.`, 'idle', true);
    return toast(p.label + ' needs a source image', true);
  }

  const body = {
    profile: state.current,
    idea,
    backend: state.settings.backend,
    apiKey: state.settings.apiKey,
    model: state.settings.model,
    temperature: Number(state.settings.temp),
    maxTokens: Number(state.settings.maxTokens),
    thinking: state.settings.thinking,
    thinkingPrefill: state.settings.prefill,
    systemMode: state.settings.sysMode,
    systemExtra: state.settings.sysExtra,
    unloadAfter: !!state.settings.unloadAfter,
    images: state.images,
    options: {
      artists: state.artists,
      tags: state.tags,
      negativeTags: state.negTags,
      negative: $('#optNegative').checked,
      aspect: $('#optAspect').value,
      variations: Number($('#optVariations').value),
      imageMode: $('#imageMode').value,
      rating: state.tags.find((t) => ['safe', 'sensitive', 'questionable', 'explicit'].includes(t)),
    },
    h3: {
      mode: $('#h3Mode').value,
      duration: Number($('#h3Duration').value),
      shots: $('#h3Shots').value,
      dialogue: $('#h3Dialogue').value.trim(),
      labels: $('#h3Labels').value.trim(),
    },
  };

  state.raw = '';
  $('#thinkOut').textContent = '';
  $('#thinkWrap').hidden = true;
  $('#negOut').hidden = true;
  $('#out').innerHTML = '<span class="cursor"></span>';
  $('#go').disabled = true;
  $('#stop').hidden = false;
  setStatus('busy', 'generating…');
  miku(
    state.images.length
      ? 'Let me have a proper look at your image…'
      : `Writing this in <b>${esc(p.label)}</b>'s dialect — one moment ♪`,
    'thinking'
  );

  const started = Date.now();
  state.abort = new AbortController();

  try {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: state.abort.signal,
    });
    if (!resp.ok) throw new Error('server said ' + resp.status);

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data:')) continue;
        let msg;
        try {
          msg = JSON.parse(line.slice(5));
        } catch {
          continue;
        }
        if (msg.type === 'content') {
          state.raw += msg.text;
          renderOut();
          $('#out').parentElement.scrollTop = $('#out').parentElement.scrollHeight;
        } else if (msg.type === 'reasoning') {
          $('#thinkWrap').hidden = false;
          $('#thinkOut').textContent += msg.text;
        } else if (msg.type === 'error') {
          $('#out').innerHTML = `<span class="err">${esc(msg.text)}</span>`;
          state.raw = '';
          miku("Something went wrong talking to the model — the details are on the right.", 'idle', true);
          toast('backend error', true);
        } else if (msg.type === 'unloading') {
          toast('freeing VRAM…');
        } else if (msg.type === 'unloaded') {
          paintGpus(msg.gpus);
          if (msg.ok) {
            toast('VRAM freed — GPU is yours ♪');
            setStatus('bad', 'unloaded');
            $('#statusText').dataset.idle = 'unloaded';
          } else if (msg.detail) {
            toast(msg.detail, true);
          }
        }
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') {
      $('#out').innerHTML = `<span class="err">${esc(err.message)}</span>`;
      toast(err.message, true);
    }
  } finally {
    state.abort = null;
    $('#go').disabled = false;
    $('#stop').hidden = true;
    renderOut();
    setStatus('ok', $('#statusText').dataset.idle || 'ready');

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const [main] = splitNegative(state.raw);
    if (main.trim()) {
      const where =
        state.profiles[state.current].family === 'h3'
          ? "the <b>Input Text (Prompt)</b> node in your H3 workflow"
          : "ComfyUI's <b>positive</b> box";
      miku(`All done ♪ Hit <b>copy</b> and paste it into ${where}.`, 'happy');
      const words = main.trim().split(/\s+/).length;
      $('#outFoot').textContent = `${main.length} chars · ${words} words · ${elapsed}s · ${state.profiles[state.current].label}`;
      $('#outFoot').classList.add('show');
      state.history.unshift({
        at: Date.now(),
        profile: state.current,
        label: state.profiles[state.current].label,
        idea,
        out: state.raw,
      });
      saveHistory();
    }
  }
}

/* ── status / models ────────────────────────────────────────── */

function setStatus(kind, text) {
  $('#statusDot').className = 'dot ' + kind;
  $('#statusText').textContent = text;
}

async function refreshModels() {
  const params = new URLSearchParams({
    backend: state.settings.backend,
    key: state.settings.apiKey,
  });
  const data = await (await fetch('/api/models?' + params)).json();
  const select = $('#llmModel');
  select.innerHTML = '';

  if (!data.models.length) {
    setStatus('bad', 'no backend');
    $('#statusText').dataset.idle = 'no backend';
    select.innerHTML = '<option>— none —</option>';
    return;
  }
  for (const id of data.models) {
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = id;
    select.appendChild(opt);
  }
  if (state.settings.model && data.models.includes(state.settings.model)) {
    select.value = state.settings.model;
  } else {
    state.settings.model = data.models[0];
    select.value = data.models[0];
    saveSettings();
  }
  const host = (data.backend || '').replace(/^https?:\/\//, '');
  setStatus('ok', host);
  $('#statusText').dataset.idle = host;
}

async function detectBackends() {
  const box = $('#foundBackends');
  box.innerHTML = '<div class="scan">scanning local ports…</div>';
  const data = await (await fetch('/api/detect')).json();
  if (!data.found.length) {
    box.innerHTML =
      '<div class="scan bad">nothing found on the usual ports. Start your server, or paste its URL above.</div>';
    return;
  }
  box.innerHTML = '';
  for (const entry of data.found) {
    const el = document.createElement('button');
    el.className = 'found-row';
    el.innerHTML =
      `<b>${esc(entry.label)}</b><span>${esc(entry.url)}</span>` +
      `<em>${entry.models.length} model${entry.models.length === 1 ? '' : 's'}</em>`;
    el.onclick = () => {
      $('#backendUrl').value = entry.url;
      state.settings.backend = entry.url;
      saveSettings();
      refreshModels();
      toast('using ' + entry.label);
    };
    box.appendChild(el);
  }
}

/* ── vram ───────────────────────────────────────────────────── */

function paintGpus(gpus) {
  if (!gpus || !gpus.length) {
    $('#vram').hidden = true;
    return;
  }
  const gpu = gpus[0];
  const pct = gpu.total ? gpu.used / gpu.total : 0;
  $('#vram').hidden = false;
  $('#vramFill').style.width = Math.round(pct * 100) + '%';
  $('#vramFill').className = pct > 0.82 ? 'hot' : '';
  $('#vramText').textContent = `${(gpu.used / 1024).toFixed(1)}/${(gpu.total / 1024).toFixed(0)}G`;
}

async function refreshGpu() {
  try {
    const data = await (await fetch('/api/gpu')).json();
    paintGpus(data.gpus);
  } catch {
    $('#vram').hidden = true;
  }
}

async function unloadModel() {
  toast('unloading…');
  const resp = await fetch('/api/unload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backend: state.settings.backend, model: state.settings.model }),
  });
  const data = await resp.json();
  paintGpus(data.gpus);
  if (data.ok) {
    toast('VRAM freed — GPU is yours ♪');
    setStatus('bad', 'unloaded');
    $('#statusText').dataset.idle = 'unloaded';
  } else {
    toast(data.detail || 'could not unload', true);
  }
}

/* ── history ────────────────────────────────────────────────── */

function renderHistory() {
  const box = $('#historyList');
  if (!state.history.length) {
    box.innerHTML = '<div class="row-empty">nothing yet</div>';
    return;
  }
  box.innerHTML = '';
  for (const item of state.history) {
    const el = document.createElement('div');
    el.className = 'hist';
    const when = new Date(item.at).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
    el.innerHTML =
      `<div class="hist-top"><b>${esc(item.label)}</b> ${esc(when)}</div>` +
      `<div class="hist-idea">${esc(item.idea || '(image only)')}</div>` +
      `<div class="hist-out">${esc(item.out.slice(0, 320))}</div>`;
    el.onclick = () => {
      state.raw = item.out;
      renderOut();
      $('#historyDrawer').hidden = true;
      toast('restored');
    };
    box.appendChild(el);
  }
}

/* ── wiring ─────────────────────────────────────────────────── */

function seg(id, key, onChange) {
  const wrap = $(id);
  wrap.querySelectorAll('button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.v === state.settings[key]);
    btn.onclick = () => {
      state.settings[key] = btn.dataset.v;
      saveSettings();
      wrap.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      if (onChange) onChange(btn.dataset.v);
    };
  });
}

function init() {
  // restore settings into the form
  $('#backendUrl').value = state.settings.backend;
  $('#apiKey').value = state.settings.apiKey;
  $('#temp').value = state.settings.temp;
  $('#tempOut').textContent = Number(state.settings.temp).toFixed(2);
  $('#maxTokens').value = state.settings.maxTokens;
  $('#sysExtra').value = state.settings.sysExtra;
  $('#thinkPrefill').value = state.settings.prefill;
  $('#favCount').textContent = state.favs.size;
  $('#prefillWrap').hidden = state.settings.thinking !== 'prefill';
  $('#unloadAfter').checked = !!state.settings.unloadAfter;
  $('#unloadAfter').onchange = (e) => {
    state.settings.unloadAfter = e.target.checked;
    saveSettings();
  };
  $('#vram').onclick = unloadModel;

  seg('#thinkMode', 'thinking', (v) => ($('#prefillWrap').hidden = v !== 'prefill'));
  seg('#sysMode', 'sysMode');

  // generation
  $('#go').onclick = generate;
  $('#stop').onclick = () => state.abort && state.abort.abort();
  $('#clearIdea').onclick = () => {
    $('#idea').value = '';
    $('#idea').focus();
  };
  $('#idea').addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') generate();
  });

  // copy
  $('#copyOut').onclick = () => {
    const [main] = splitNegative(state.raw);
    if (!main.trim()) return toast('nothing to copy', true);
    navigator.clipboard.writeText(main).then(() => toast('prompt copied ♪'));
  };
  $('#copyNeg').onclick = () => {
    navigator.clipboard.writeText($('#negText').textContent).then(() => toast('negative copied'));
  };

  // images
  $('#addImage').onclick = () => $('#fileInput').click();
  $('#fileInput').onchange = (e) => {
    addFiles([...e.target.files]);
    e.target.value = '';
  };
  const dz = $('#dropzone');
  ['dragenter', 'dragover'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.add('hot');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    dz.addEventListener(ev, (e) => {
      e.preventDefault();
      dz.classList.remove('hot');
    })
  );
  dz.addEventListener('drop', (e) => addFiles([...e.dataTransfer.files]));
  document.addEventListener('paste', (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) addFiles(files);
  });

  // drawers
  const drawer = (openBtn, id, onOpen) => {
    $(openBtn).onclick = () => {
      $(id).hidden = false;
      if (onOpen) onOpen();
    };
    $(id).addEventListener('click', (e) => {
      if (e.target === $(id)) $(id).hidden = true;
    });
  };
  drawer('#openArtists', '#artistDrawer', () => {
    searchArtists(true);
    $('#artistSearch').focus();
  });
  drawer('#openTags', '#tagDrawer', () => renderTagSets());
  drawer('#openSettings', '#settingsDrawer', () => detectBackends());
  drawer('#openHistory', '#historyDrawer', renderHistory);
  $('#closeArtists').onclick = () => ($('#artistDrawer').hidden = true);
  $('#closeTags').onclick = () => ($('#tagDrawer').hidden = true);
  $('#closeSettings').onclick = () => ($('#settingsDrawer').hidden = true);
  $('#closeHistory').onclick = () => ($('#historyDrawer').hidden = true);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.querySelectorAll('.drawer').forEach((d) => (d.hidden = true));
  });

  // artist browser
  $('#artistSearch').addEventListener('input', (e) => {
    state.artistQuery = e.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => searchArtists(true), 170);
  });
  $('#artistTab').querySelectorAll('button').forEach((btn) => {
    btn.onclick = () => {
      artistTab = btn.dataset.tab;
      $('#artistTab').querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn));
      searchArtists(true);
    };
  });
  $('#loadMoreArtists').onclick = () => {
    state.artistOffset += 80;
    searchArtists(false);
  };
  $('#exportArtists').onclick = async () => {
    const artists = state.favs.size ? [...state.favs] : state.artists;
    if (!artists.length) return toast('favourite some artists first', true);
    const resp = await fetch('/api/export-artists', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ artists }),
    });
    const data = await resp.json();
    if (data.error) return toast(data.error, true);
    toast(`wrote ${data.count} artists to ${data.written.length} files — restart ComfyUI`);
  };

  // tag browser
  $('#tagSearch').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(searchTags, 170);
  });
  $('#tagKind').onchange = searchTags;

  // settings fields
  $('#llmModel').onchange = (e) => {
    state.settings.model = e.target.value;
    saveSettings();
  };
  $('#backendUrl').onchange = (e) => {
    state.settings.backend = e.target.value.trim();
    saveSettings();
    refreshModels();
  };
  $('#apiKey').onchange = (e) => {
    state.settings.apiKey = e.target.value;
    saveSettings();
    refreshModels();
  };
  $('#detectBackend').onclick = detectBackends;
  $('#temp').oninput = (e) => {
    state.settings.temp = e.target.value;
    state.settings.tempTouched = true;
    $('#tempOut').textContent = Number(e.target.value).toFixed(2);
    saveSettings();
  };
  $('#maxTokens').onchange = (e) => {
    state.settings.maxTokens = e.target.value;
    state.settings.tokensTouched = true;
    saveSettings();
  };
  $('#sysExtra').onchange = (e) => {
    state.settings.sysExtra = e.target.value;
    saveSettings();
  };
  $('#thinkPrefill').onchange = (e) => {
    state.settings.prefill = e.target.value;
    saveSettings();
  };
  $('#h3Duration').oninput = (e) => {
    $('#h3DurationOut').textContent = Number(e.target.value).toFixed(1) + 's';
  };

  $('#dryRun').onclick = async () => {
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profile: state.current,
        idea: $('#idea').value,
        dryRun: true,
        systemMode: state.settings.sysMode,
        systemExtra: state.settings.sysExtra,
        thinking: state.settings.thinking,
        options: { artists: state.artists, tags: state.tags, negative: $('#optNegative').checked },
        h3: { mode: $('#h3Mode').value, duration: Number($('#h3Duration').value) },
      }),
    });
    const data = await resp.json();
    $('#dryOut').hidden = false;
    $('#dryOut').textContent = data.messages[0].content;
  };

  $('#clearHistory').onclick = () => {
    state.history = [];
    saveHistory();
    renderHistory();
  };
  $('#resetAll').onclick = () => {
    localStorage.removeItem(LS.settings);
    localStorage.removeItem(LS.favs);
    localStorage.removeItem(LS.history);
    location.reload();
  };

  loadProfiles();
  loadTagSets();
  refreshModels();
  refreshGpu();
  setInterval(refreshGpu, 8000);

  fetch('/api/health')
    .then((r) => r.json())
    .then((h) => {
      $('#diag').innerHTML =
        `<b>tags</b>      ${h.tags.toLocaleString()}\n` +
        `<b>artists</b>   ${h.artists.toLocaleString()}\n` +
        `<b>tag file</b>  ${esc(h.tagfile)}\n` +
        `<b>comfyui</b>   ${esc(h.comfy)}\n` +
        `<b>default</b>   ${esc(h.backend)}`;
      if (!state.settings.backend) {
        state.settings.backend = h.backend;
        $('#backendUrl').value = h.backend;
        saveSettings();
      }
    });
}

init();
