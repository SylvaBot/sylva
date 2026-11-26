// Clean Twitch-style Chat for StreamElements (Custom Widget)
// Full-canvas (1920x1080). Shows chat like Twitch does (badges, name colors,
// emotes, /me, @mentions, replies) on a transparent background, and hides
// commands and any users you list.

var settings = {};
var hiddenUsers = {};
var prefixes = [];
var regionEl = document.getElementById('region');
var listEl = document.getElementById('list');

// Twitch's default name colors for users who never picked one
var DEFAULT_COLORS = ['#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50', '#9ACD32', '#FF4500',
  '#2E8B57', '#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F'];

function setting(key, fallback) {
  var value = settings[key];
  return value === undefined || value === null || value === '' ? fallback : value;
}

function num(value, fallback) {
  var n = Number(value);
  return isFinite(n) ? n : (fallback || 0);
}

window.addEventListener('onWidgetLoad', function (obj) {
  settings = (obj && obj.detail && obj.detail.fieldData) || {};
  var root = document.documentElement.style;
  var font = String(setting('fontFamily', 'Inter'));
  root.setProperty('--font', "'" + font + "', 'Inter', 'Segoe UI', Arial, sans-serif");
  // Text size is a share of the screen width, so it scales with the source
  root.setProperty('--size', num(setting('textSize', 3.8), 3.8) + 'vw');
  root.setProperty('--text', setting('textColor', '#EFEFF1'));
  root.setProperty('--line', String(num(setting('lineHeight', 1.5), 1.5)));
  root.setProperty('--gap', num(setting('messageGap', 0.2), 0.2) + 'em');
  root.setProperty('--pad', num(setting('edgeSpace', 0.4), 0.4) + 'em');
  regionEl.classList.toggle('shadow', setting('textShadow', true) !== false);
  regionEl.classList.toggle('fade-top', setting('fadeTop', true) !== false);

  hiddenUsers = {};
  String(setting('hiddenUsers', '')).split(/[\s,]+/).forEach(function (u) {
    u = u.trim().replace(/^@/, '').toLowerCase();
    if (u) hiddenUsers[u] = true;
  });
  prefixes = String(setting('commandPrefixes', '!')).split(/\s+/).filter(Boolean);

  var link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css?family=' +
    encodeURIComponent(font).replace(/%20/g, '+') + ':400,700&display=swap';
  document.head.appendChild(link);
});

window.addEventListener('onEventReceived', function (obj) {
  var detail = (obj && obj.detail) || {};
  var listener = detail.listener;
  var event = detail.event || {};

  if (listener === 'message') {
    try { addMessage(event.data || {}); } catch (err) {}
  } else if (listener === 'delete-message') {
    removeWhere(function (el) { return el.dataset.msgId && el.dataset.msgId === String(event.msgId); });
  } else if (listener === 'delete-messages') {
    removeWhere(function (el) { return el.dataset.userId && el.dataset.userId === String(event.userId); });
  } else if (listener === 'widget-button' && event.field === 'testChat') {
    runTest();
  }
});

/* ---------- Filtering ---------- */

function shouldHide(data, text) {
  var login = String(data.nick || data.username || '').toLowerCase();
  var display = String(data.displayName || '').toLowerCase();
  if (hiddenUsers[login] || hiddenUsers[display]) return true;
  if (setting('hideCommands', true) !== false) {
    for (var i = 0; i < prefixes.length; i++) {
      if (text.indexOf(prefixes[i]) === 0) return true;
    }
  }
  return false;
}

/* ---------- Building a message ---------- */

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function hashColor(name) {
  var h = 0;
  for (var i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return DEFAULT_COLORS[h % DEFAULT_COLORS.length];
}

// Brighten name colors that would be hard to read, like Twitch's dark mode does
function readable(hex) {
  var m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return hex;
  var n = parseInt(m[1], 16);
  var r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  if (lum >= 0.35) return '#' + m[1];
  var t = Math.min(0.75, (0.35 - lum) / 0.35 * 0.75 + 0.15);
  r = Math.round(r + (255 - r) * t);
  g = Math.round(g + (255 - g) * t);
  b = Math.round(b + (255 - b) * t);
  return 'rgb(' + r + ', ' + g + ', ' + b + ')';
}

function emoteUrl(e) {
  var u = e && e.urls ? (e.urls['4'] || e.urls['2'] || e.urls['1']) : '';
  return u || '';
}

// Turn message text into HTML with emotes and bold @mentions
function renderText(text, emotes) {
  var map = {};
  (emotes || []).forEach(function (e) {
    if (e && e.name && emoteUrl(e)) map[e.name] = emoteUrl(e);
  });
  var parts = String(text).split(/(\s+)/);
  var out = '';
  for (var i = 0; i < parts.length; i++) {
    var p = parts[i];
    if (!p) continue;
    if (/^\s+$/.test(p)) { out += ' '; continue; }
    if (map.hasOwnProperty(p)) {
      out += '<img class="emote" src="' + escapeHtml(map[p]) + '" alt="' + escapeHtml(p) + '">';
    } else if (/^@\w+/.test(p)) {
      out += '<span class="mention">' + escapeHtml(p) + '</span>';
    } else {
      out += escapeHtml(p);
    }
  }
  return out;
}

function addMessage(data) {
  var text = String(data.text || '');
  if (!text.trim()) return;
  if (shouldHide(data, text.trim())) return;

  var login = String(data.nick || data.username || '').toLowerCase();
  var display = String(data.displayName || data.nick || 'unknown');
  var color = data.displayColor || (data.tags && data.tags.color) || hashColor(login || display);
  if (setting('readableColors', true) !== false) color = readable(color);

  var el = document.createElement('div');
  el.className = 'msg' + (data.isAction ? ' action' : '');
  el.style.setProperty('--name-color', color);
  if (data.msgId) el.dataset.msgId = String(data.msgId);
  if (data.userId) el.dataset.userId = String(data.userId);

  var html = '';

  // Reply header
  var tags = data.tags || {};
  if (setting('showReplies', true) !== false && tags['reply-parent-display-name']) {
    html += '<span class="reply">Replying to @' + escapeHtml(tags['reply-parent-display-name']) + ': ' +
      escapeHtml(String(tags['reply-parent-msg-body'] || '').replace(/\\s/g, ' ')) + '</span>';
    // Twitch adds "@name " to the start of replies; the header already shows it
    var lead = '@' + tags['reply-parent-display-name'] + ' ';
    if (text.indexOf(lead) === 0) text = text.slice(lead.length);
  }

  if (setting('showBadges', true) !== false && Array.isArray(data.badges)) {
    data.badges.forEach(function (b) {
      if (b && b.url) html += '<img class="badge" src="' + escapeHtml(b.url) + '" alt="">';
    });
  }

  // Twitch shows "DisplayName (login)" for names in non-Latin scripts
  var nameText = display;
  if (login && display.toLowerCase() !== login && /[^\x00-\x7F]/.test(display)) {
    nameText = display + ' (' + login + ')';
  }
  html += '<span class="name" style="color:' + escapeHtml(color) + '">' + escapeHtml(nameText) + '</span>';
  html += data.isAction ? ' ' : '<span class="colon">:</span>';
  html += '<span class="text">' + renderText(text, data.emotes) + '</span>';

  el.innerHTML = html;
  append(el);
}

/* ---------- Adding and removing lines ---------- */

function append(el) {
  listEl.appendChild(el);

  // Glide the older lines up instead of jumping
  var h = el.getBoundingClientRect().height + parseFloat(getComputedStyle(listEl).rowGap || 0);
  listEl.style.transition = 'none';
  listEl.style.transform = 'translateY(' + h + 'px)';
  void listEl.offsetHeight;
  listEl.style.transition = 'transform 0.25s ease-out';
  listEl.style.transform = 'translateY(0)';

  trim();

  var fade = num(setting('fadeAfter', 0), 0);
  if (fade > 0) {
    setTimeout(function () { removeEl(el); }, fade * 1000);
  }
}

function trim() {
  var max = Math.max(5, num(setting('maxMessages', 50), 50));
  var kids = listEl.children;
  while (kids.length > max) listEl.removeChild(kids[0]);

  // Drop lines that have scrolled fully out of the chat area
  var top = regionEl.getBoundingClientRect().top;
  var extra = regionEl.clientHeight * 0.5;
  while (listEl.firstChild && listEl.firstChild.getBoundingClientRect().bottom < top - extra) {
    listEl.removeChild(listEl.firstChild);
  }
}

function removeEl(el) {
  if (!el.parentNode || el.classList.contains('removing')) return;
  el.classList.add('removing');
  setTimeout(function () {
    if (el.parentNode) el.parentNode.removeChild(el);
  }, 400);
}

function removeWhere(test) {
  Array.prototype.slice.call(listEl.children).forEach(function (el) {
    if (test(el)) removeEl(el);
  });
}

/* ---------- Test button ---------- */

function runTest() {
  var kappa = { name: 'Kappa', urls: { '1': 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/1.0', '2': 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0', '4': 'https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/3.0' } };
  var samples = [
    { nick: 'kettlewitch', displayName: 'kettlewitch', displayColor: '#FF69B4', text: 'hey chat, how is everyone doing today' },
    { nick: 'orbitalfern', displayName: 'OrbitalFern', displayColor: '#1E90FF', text: 'that was so clean Kappa', emotes: [kappa] },
    { nick: 'harborlight', displayName: 'harborlight', displayColor: '#00FF7F', text: 'waves at chat', isAction: true },
    { nick: 'streamelements', displayName: 'StreamElements', text: 'This message is from a bot and should be hidden if listed' },
    { nick: 'someviewer', displayName: 'someviewer', text: '!discord' },
    { nick: 'darkname', displayName: 'darkname', displayColor: '#0000FF', text: '@kettlewitch dark blue names get brightened so you can read them' }
  ];
  samples.forEach(function (s, i) {
    setTimeout(function () {
      window.dispatchEvent(new CustomEvent('onEventReceived', { detail: { listener: 'message', event: { data: s } } }));
    }, i * 600);
  });
}
