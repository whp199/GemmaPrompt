/* GemmaPrompt — client */

const $ = (s) => document.querySelector(s);
const LS = {
  settings: 'gemmaprompt.settings',
  favs: 'gemmaprompt.favourites',
  history: 'gemmaprompt.history',
};

function readSaved(key, fallback) {
  try {
    const value = JSON.parse(localStorage.getItem(key));
    if (Array.isArray(fallback)) return Array.isArray(value) ? value : fallback;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : fallback;
  } catch { return fallback; }
}
function writeSaved(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { toast('Browser storage is full or unavailable. This session still works.', true); }
}

const state = {
  profiles: {},
  groups: [],
  current: null,
  artists: [],
  tags: [],
  negTags: [],
  images: [],
  videos: [],
  mediaAbort: null,
  favs: new Set(readSaved(LS.favs, [])),
  history: readSaved(LS.history, []),
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
    readSaved(LS.settings, {})
  ),
  abort: null,
  raw: '',
  outputMusic: null,
  artistOffset: 0,
  artistQuery: '',
};

const saveSettings = () => writeSaved(LS.settings, state.settings);
const saveFavs = () => writeSaved(LS.favs, [...state.favs]);
const saveHistory = () =>
  writeSaved(LS.history, state.history.slice(0, 60));

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

/* ── gemma-chan ─────────────────────────────────────────────── */

const MOODS = {
  idle: '/img/gemma-idle.webp',
  smug: '/img/gemma-smug.webp',
  thinking: '/img/gemma-thinking.webp',
  proud: '/img/gemma-proud.webp',
  fluster: '/img/gemma-fluster.webp',
  point: '/img/gemma-point.webp',
};
let gemmaMood = 'idle';

function gemma(text, mood = 'idle', warn = false) {
  const bubble = $('#gemmaSay');
  bubble.className = 'bubble' + (warn ? ' warn' : '');
  bubble.innerHTML = text;
  // restart the entrance animation so repeated lines still register
  bubble.style.animation = 'none';
  void bubble.offsetWidth;
  bubble.style.animation = '';

  if (mood !== gemmaMood && MOODS[mood]) {
    gemmaMood = mood;
    const img = $('#gemmaImg');
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
  $('#musicBlock').hidden = p.family !== 'music3';
  $('#visualOptions').hidden = p.family === 'music3';
  $('#idea').placeholder = p.family === 'music3'
    ? 'Describe the music: genre, groove, instruments, voice, and how it should develop…'
    : 'Describe your idea, subject, style, or scene…';
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

  let line = p.gemma || `I'll write for <b>${esc(p.label)}</b>.`;
  if (p.visionRequired) {
    line += ' <em>This one needs an image to work from.</em>';
  }
  gemma(line, 'idle', !!p.visionRequired && !state.images.length);
}

/* ── chips ──────────────────────────────────────────────────── */

function renderChips() {
  const ac = $('#artistChips');
  if (!state.artists.length) {
    ac.innerHTML = '<span class="empty">Nothing picked. Artist tags are the single strongest style lever Anima has — go on.</span>';
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
    tc.innerHTML = "<span class=\"empty\">Empty. I'll choose for you, but you won't like it.</span>";
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
        if (scale === 1 && reader.result.length < 1.4e6 && /^image\/(jpeg|png|webp|gif)$/.test(file.type)) return resolve(reader.result);
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
  if (state.mediaAbort) return toast('wait for the current import or cancel it first', true);
  const controller = new AbortController();
  state.mediaAbort = controller;
  $('#cancelMedia').hidden = false;
  const count = Number($('#videoFrames').value);
  try {
    for (const file of files) {
      if (controller.signal.aborted) break;
      try {
        if (file.type.startsWith('image/')) {
          const image = await fileToImage(file);
          if (!controller.signal.aborted) state.images.push(image);
        } else if (file.type.startsWith('video/') || /\.(mp4|webm|mov|m4v|mkv)$/i.test(file.name)) {
          $('#mediaStatus').textContent = `Opening ${file.name}…`;
          const video = await GemmaMedia.videoFrames(file, count, controller.signal, (n, total) => {
            $('#mediaStatus').textContent = `${file.name}: sampling frame ${n} of ${total}…`;
          });
          state.videos.push(video);
        } else {
          toast('unsupported reference: ' + file.name, true);
        }
        renderThumbs();
      } catch (err) {
        if (err.name === 'AbortError') break;
        toast(file.name + ': ' + (err.message || 'could not read file'), true);
        $('#mediaStatus').textContent = file.name + ': ' + (err.message || 'could not read file');
      }
    }
  } finally {
    state.mediaAbort = null;
    $('#cancelMedia').hidden = true;
    if (controller.signal.aborted) $('#mediaStatus').textContent = 'Import cancelled. Completed references are ready.';
    else if (state.images.length || state.videos.length) {
      $('#mediaStatus').textContent = `${state.images.length} image(s), ${state.videos.length} video(s) ready.`;
      gemma("References ready. I can analyze them or use them to write your prompt.", 'smug');
    }
  }
}

function clearReferences() {
  state.mediaAbort?.abort();
  state.images = [];
  state.videos.forEach((video) => URL.revokeObjectURL(video.preview));
  state.videos = [];
  renderThumbs();
  $('#mediaStatus').textContent = '';
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
  state.videos.forEach((video, i) => {
    const card = document.createElement('div');
    card.className = 'video-reference';
    const player = document.createElement('video');
    player.src = video.preview;
    player.controls = true;
    player.preload = 'metadata';
    const title = document.createElement('div');
    title.className = 'reference-title';
    const label = document.createElement('span');
    label.textContent = `Video ${i + 1} · ${video.name} · ${video.duration.toFixed(2)}s`;
    const remove = document.createElement('button');
    remove.className = 'ghost-btn';
    remove.textContent = 'remove';
    remove.onclick = () => {
      URL.revokeObjectURL(video.preview);
      state.videos.splice(i, 1);
      renderThumbs();
    };
    title.append(label, remove);
    const strip = document.createElement('div');
    strip.className = 'filmstrip';
    video.frames.forEach((frame) => {
      const figure = document.createElement('figure');
      const img = document.createElement('img');
      img.src = frame.url;
      img.alt = `Video ${i + 1} at ${frame.time.toFixed(3)} seconds`;
      const caption = document.createElement('figcaption');
      caption.textContent = `${frame.time.toFixed(3)}s`;
      figure.append(img, caption);
      strip.appendChild(figure);
    });
    card.append(player, title, strip);
    box.appendChild(card);
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
    .replace(/^### (Global Metadata|Vocal Details|Arrangement)$/gm, '<span class="sect">### $1</span>')
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

const PRAISE = [
  'There. Obviously perfect.',
  'Done. You could at least look impressed.',
  'That took me no effort at all, by the way.',
  "Finished. ...It's good. Not that I care if you like it.",
  "Hmph. I may have put a bit of work into that one.",
  'Done. Try not to waste it on something boring.',
];
const praise = () => PRAISE[Math.floor(Math.random() * PRAISE.length)];

/* ── generate ───────────────────────────────────────────────── */

function buildRequest() {
  const isMusic = state.profiles[state.current]?.family === 'music3';
  return {
    profile: state.current,
    idea: $('#idea').value.trim(),
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
    images: isMusic ? [] : state.images.slice(),
    videos: isMusic ? [] : state.videos.map(({ name, duration, frames }) => ({ name, duration, frames })),
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
    music: {
      vocals: $('#musicVocals').value,
      lyrics: $('#musicLyrics').value,
      constraints: $('#musicConstraints').value.trim(),
    },
    h3: {
      musicMode: $('#h3MusicMode').value,
      musicDirection: $('#h3MusicDirection').value.trim(),
      mode: $('#h3Mode').value,
      duration: Number($('#h3Duration').value),
      shots: $('#h3Shots').value,
      dialogue: $('#h3Dialogue').value.trim(),
      labels: $('#h3Labels').value.trim(),
    },
  };
}

async function generate(analysisOnly = false) {
  if (state.abort) return;
  if (state.mediaAbort) return toast('wait for reference sampling to finish', true);
  if (!state.current) return toast('profiles are still loading', true);
  if (!$('#h3Block').hidden && !$('#h3Shots').reportValidity()) return;
  if (!$('#maxTokens').reportValidity()) return;
  if (analysisOnly && !state.images.length && !state.videos.length) return toast('add a reference first', true);
  const idea = $('#idea').value.trim();
  const p = state.profiles[state.current];
  if (!idea && (p.family === 'music3' || (!state.images.length && !state.videos.length))) {
    gemma("...You want me to work from <em>nothing</em>? Type something. <b>girl on a rooftop</b> would do. I'm good, not psychic.", 'idle', true);
    return toast('describe an idea first', true);
  }
  if (!analysisOnly && p.visionRequired && !state.images.length) {
    gemma(`<b>${esc(p.label)}</b> edits <em>pictures</em>. As in, one you give it. Drop an image in the reference box and try again.`, 'idle', true);
    return toast(p.label + ' needs a source image', true);
  }

  const body = { ...buildRequest(), analysisOnly };

  state.raw = '';
  state.outputMusic = null;
  $('#musicOutputTools').hidden = true;
  $('#outFoot').classList.remove('show');
  $('#thinkOut').textContent = '';
  $('#thinkWrap').hidden = true;
  $('#negOut').hidden = true;
  $('#out').innerHTML = '<span class="cursor"></span>';
  $('#go').disabled = true;
  $('#stop').hidden = false;
  setStatus('busy', 'generating…');
  gemma(
    (state.images.length || state.videos.length)
      ? "Hmph. Let me actually <em>look</em> at this properly — unlike some people."
      : `Fine. Rewriting this the way <b>${esc(p.label)}</b> actually wants it. Don't rush me.`,
    'thinking'
  );

  let failure = '';
  let completed = false;
  let cancelled = false;
  let truncated = false;
  const started = Date.now();
  state.abort = new AbortController();

  try {
    const encoded = JSON.stringify(body);
    if (new Blob([encoded]).size > 64 * 1024 * 1024) throw new Error('References exceed the 64 MB request budget. Remove references or sample fewer video frames.');
    const resp = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: encoded,
      signal: state.abort.signal,
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.error || 'server said ' + resp.status);
    }

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
        } else if (msg.type === 'status') {
          setStatus('busy', msg.text);
        } else if (msg.type === 'reasoning') {
          $('#thinkWrap').hidden = false;
          $('#thinkOut').textContent += msg.text;
        } else if (msg.type === 'error') {
          failure = msg.text;
        } else if (msg.type === 'done') {
          completed = true;
          truncated = msg.finish_reason === 'length';
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
    cancelled = err.name === 'AbortError';
    if (!cancelled) failure = err.message;
  } finally {
    state.abort = null;
    $('#go').disabled = false;
    $('#stop').hidden = true;
    renderOut();
    if (!completed && !cancelled && !failure) failure = 'The backend stream ended before completion. Please retry.';
    if (failure) {
      const error = document.createElement('div');
      error.className = 'err';
      error.textContent = failure;
      $('#out').appendChild(error);
      toast(failure, true);
    }
    const incomplete = failure || cancelled || truncated;
    setStatus(incomplete ? 'bad' : 'ok', failure ? 'error' : cancelled ? 'stopped' : truncated ? 'output limit reached' : $('#statusText').dataset.idle || 'ready');
    if (incomplete) gemma(cancelled ? 'Stopped. Any partial output is kept below.' : truncated ? 'The output token limit cut this short. Increase Max tokens in Settings and generate again.' : 'The request failed. The details are in the output panel.', 'idle', true);

    const elapsed = ((Date.now() - started) / 1000).toFixed(1);
    const [main] = splitNegative(state.raw);
    if (main.trim()) {
      const where =
        p.family === 'music3'
          ? "your music workflow's <b>caption / instructions</b> field"
          : p.family === 'h3'
          ? "the <b>Input Text (Prompt)</b> node in your H3 workflow"
          : "ComfyUI's <b>positive</b> box";
      if (!incomplete) gemma(analysisOnly ? 'Reference analysis ready. Use these notes to refine your idea, then hit <b>Fix my prompt</b>.' : `${praise()} Hit <b>copy</b> and put it in ${where}.`, Math.random() < 0.3 ? 'fluster' : 'proud');
      const words = main.trim().split(/\s+/).length;
      $('#outFoot').textContent = `${main.length} chars · ${words} words · ${elapsed}s · ${p.label}${incomplete ? ' · partial' : ''}`;
      $('#outFoot').classList.add('show');
      if (!incomplete && p.family === 'music3') {
        state.outputMusic = { lyrics: body.music.lyrics, caption: state.raw };
        $('#musicOutputTools').hidden = false;
      }
      if (!incomplete) state.history.unshift({
        at: Date.now(),
        profile: body.profile,
        label: p.label,
        idea,
        out: state.raw,
        music: state.outputMusic,
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
  if (state.abort) return toast('stop generation before unloading the model', true);
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
      if (state.abort) return toast('stop generation before restoring history', true);
      state.raw = item.out;
      state.outputMusic = item.music || null;
      $('#musicOutputTools').hidden = !state.outputMusic;
      renderOut();
      $('#historyDrawer').hidden = true;
      toast('restored');
    };
    box.appendChild(el);
  }
}


/* ── walkthrough ────────────────────────────────────────────── */

/* Each step spotlights a real element and Gemma-chan explains it.
   `when` skips steps whose target is hidden for the current profile. */
const TOUR = [
  {
    el: '.gemma',
    title: "So you're new.",
    text: "I'm Gemma-chan. You type something lazy, I turn it into a prompt the model actually understands. " +
          "It's not hard for me, so don't look so worried. Come on — I'll show you where everything is.",
    mood: 'smug',
  },
  {
    el: '.col-models',
    title: 'Pick who it\'s for',
    text: "Every one of these wants a <em>completely different</em> kind of text. Anima wants booru tags. " +
          "Klein wants prose. H3 wants six labelled sections. Pick the one you're actually going to run — " +
          "I change how I write based on this.",
    mood: 'point',
  },
  {
    el: '#idea',
    title: 'Be as lazy as you like',
    text: "Type your idea here. <b>Three words is fine.</b> That's the entire point of me — you bring the idea, " +
          "I do the boring part. <em>Ctrl+Enter</em> runs it if you can't find the button.",
    mood: 'idle',
  },
  {
    el: '#visionBlock',
    title: 'Or just show me',
    text: "Drop an image or video in and I'll actually look at it. <b>Inform</b> builds on it, <b>reproduce</b> writes a prompt " +
          "that recreates it, <b>style only</b> takes the look and leaves your subject alone.",
    mood: 'point',
    when: () => !$('#visionBlock').hidden,
  },
  {
    el: '#h3Block',
    title: 'H3 is the fussy one',
    text: "Six sections, exact field names, cut times that must land inside the duration. Set the duration and mode here — " +
          "I handle the rest of the spec so you don't have to read it.",
    mood: 'thinking',
    when: () => !$('#h3Block').hidden,
  },
  {
    el: '#artistBlock',
    title: 'Steal a style',
    text: "All 59,201 Danbooru artist tags, sorted by post count. Artist tags are the <em>strongest</em> style lever " +
          "Anima has — one changes the whole image. Star your favourites and I'll keep them.",
    mood: 'smug',
    when: () => !$('#artistBlock').hidden,
  },
  {
    el: '#tagBlock',
    title: 'Extra tags, if you insist',
    text: "Curated sets for lighting, framing, expression, all that. Or search all 150,000. " +
          "I'll slot whatever you pick into the correct position — order matters more than you think.",
    mood: 'idle',
    when: () => !$('#tagBlock').hidden,
  },
  {
    el: '#go',
    title: 'Then hit this',
    text: "That's it. That's the whole job. I'll write it in the right dialect and you take the credit, as usual.",
    mood: 'proud',
  },
  {
    el: '.col-out',
    title: 'And take your prompt',
    text: "It streams in here. <b>copy</b> puts it on your clipboard, ready for ComfyUI. If I was thinking out loud, " +
          "that's tucked away separately — it never ends up in what you copy.",
    mood: 'point',
  },
  {
    el: '#vram',
    title: 'When the GPU runs out',
    text: "Your LLM and your diffusion model fight over the same card. Click this and I'll get out of the way " +
          "so ComfyUI can load. ...You're welcome.",
    mood: 'fluster',
    when: () => !$('#vram').hidden,
  },
  {
    el: '#openSettings',
    title: 'The rest lives in here',
    text: "Backend URL, thinking mode, temperature, and the system prompt if you think you can do better than me. " +
          "<em>You can't.</em> But it's there.",
    mood: 'smug',
  },
];

let tourSteps = [], tourAt = 0;

function tourShow(i) {
  const step = tourSteps[i];
  if (!step) return tourEnd();
  tourAt = i;

  const target = document.querySelector(step.el);
  const hole = $('#tourHole');
  const card = $('#tourCard');

  if (target) {
    const r = target.getBoundingClientRect();
    const pad = 6;
    hole.style.cssText =
      `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px`;

    // place the card wherever there's room, preferring the side with space
    const cw = Math.min(370, Math.max(240, innerWidth - 20));
    const ch = 210, gap = 16;
    const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, Math.max(lo, hi)));

    let left = r.right + gap;
    if (left + cw > innerWidth - 10) left = r.left - cw - gap;
    left = clamp(left, 10, innerWidth - cw - 10);
    const top = clamp(r.top, 10, innerHeight - ch - 10);
    card.style.cssText = `left:${left}px;top:${top}px`;
  } else {
    hole.style.cssText = 'left:50%;top:50%;width:0;height:0';
    card.style.cssText = `left:${(innerWidth - 370) / 2}px;top:${innerHeight / 2 - 110}px`;
  }

  $('#tourTitle').textContent = step.title;
  $('#tourText').innerHTML = step.text;
  $('#tourFace').src = MOODS[step.mood] || MOODS.idle;
  $('#tourNext').textContent = i === tourSteps.length - 1 ? 'got it' : 'next';
  $('#tourDots').innerHTML = tourSteps
    .map((_, n) => `<i class="${n === i ? 'on' : ''}"></i>`)
    .join('');
}

function tourStart() {
  tourSteps = TOUR.filter((s) => !s.when || s.when());
  $('#tour').hidden = false;
  tourShow(0);
}

function tourEnd() {
  $('#tour').hidden = true;
  localStorage.setItem('gemmaprompt.toured', '1');
  gemma("Right, that's everything. Go on then — make something.", 'smug');
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

  $('#h3MusicMode').onchange = () => {
    $('#h3MusicWrap').hidden = $('#h3MusicMode').value !== 'custom';
  };
  $('#copyMusicLyrics').onclick = () => {
    if (!state.outputMusic) return;
    navigator.clipboard.writeText(state.outputMusic.lyrics).then(() => toast('original lyrics copied'));
  };
  $('#copyMusicJson').onclick = () => {
    if (!state.outputMusic) return;
    navigator.clipboard.writeText(JSON.stringify({ instructions: state.outputMusic.caption, input: state.outputMusic.lyrics }, null, 2))
      .then(() => toast('caption and lyrics JSON copied'));
  };

  // generation
  $('#go').onclick = () => generate();
  $('#analyzeRefs').onclick = () => generate(true);
  $('#clearRefs').onclick = clearReferences;
  $('#cancelMedia').onclick = () => state.mediaAbort?.abort();
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
      body: JSON.stringify({ ...buildRequest(), dryRun: true }),
    });
    const data = await resp.json();
    $('#dryOut').hidden = false;
    $('#dryOut').textContent = data.error || data.messages[0].content;
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

  $('#openTour').onclick = tourStart;
  $('#tourNext').onclick = () => tourShow(tourAt + 1);
  $('#tourSkip').onclick = tourEnd;
  $('#tourVeil').onclick = tourEnd;
  addEventListener('resize', () => {
    if (!$('#tour').hidden) tourShow(tourAt);
  });

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
      if (!localStorage.getItem('gemmaprompt.toured')) {
        setTimeout(tourStart, 700);
      }
      if (!state.settings.backend) {
        state.settings.backend = h.backend;
        $('#backendUrl').value = h.backend;
        saveSettings();
      }
    });
}

init();
