// Lobby front-end: the game's real entry point. Players create a lobby (mode,
// day length, Poké Ball allowance) or join one by 6-digit code, picking a name,
// starter (Lv5) and character. Previously-played lobbies appear under "Resume"
// (identity remembered in localStorage) for one-tap reconnection.
//
// Pure view + a LobbyConnection. On success it hands { conn, config, save } to
// onEnterGame, which boots the GameController wired to that connection.
import { spriteFront } from './data.js';
import { LobbyConnection, recentIdentities, forgetIdentity } from './lobbynet.js';

const CHARACTERS = [
  { id: 'red', name: 'Red', color: '#e3493b' },
  { id: 'blue', name: 'Blue', color: '#4a7adf' },
  { id: 'green', name: 'Green', color: '#46b16b' },
  { id: 'gold', name: 'Gold', color: '#e0a32c' },
  { id: 'silver', name: 'Silver', color: '#9aa6b2' },
  { id: 'kris', name: 'Kris', color: '#36c0c0' },
];

const DAY_PRESETS = [
  { id: '24hour', label: '24 hours', sub: 'Default' },
  { id: '1hour', label: '1 hour', sub: 'Fast' },
  { id: '1min', label: '1 minute', sub: 'Testing' },
];

const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};

export class LobbyScreen {
  constructor(dex, world, { onEnterGame } = {}) {
    this.dex = dex;
    this.world = world;
    this.onEnterGame = onEnterGame || (() => {});
    this.conn = null;
    this.busy = false;
    this.msg = '';
    // Form state for create/join.
    this.form = {
      mode: 'free',
      dayLength: '24hour',
      ballAllowance: 25,            // 5–99 per map, or 'infinite' (slider max)
      name: '',
      starter: world.progression.starters[0],
      character: 'red',
    };
    this.view = 'home';
    this.root = el('div', { class: 'lobby-wrap' });
    this.render();
  }

  // ---- connection helper -------------------------------------------------
  ensureConn() {
    if (!this.conn) this.conn = new LobbyConnection();
    return this.conn;
  }

  setMsg(text, isError) { this.msg = text || ''; this.msgIsError = !!isError; this.render(); }

  // ---- actions -----------------------------------------------------------
  async doCreate() {
    if (this.busy) return;
    this.busy = true; this.setMsg('Creating lobby…');
    try {
      const conn = this.ensureConn();
      const opts = {
        mode: this.form.mode,
        dayLength: this.form.dayLength,
        ballAllowance: this.form.ballAllowance,
        name: this.form.name.trim() || 'Player',
        starter: this.form.starter,
        character: this.form.character,
      };
      const m = await conn.createLobby(opts);
      this.enter(m);
    } catch (err) {
      this.busy = false;
      this.setMsg(err.message || 'Could not create lobby. Is the server running? (npm run server)', true);
    }
  }

  async doJoin() {
    if (this.busy) return;
    const code = (this.form.code || '').replace(/\D/g, '');
    if (code.length !== 6) { this.setMsg('Enter the 6-digit lobby code.', true); return; }
    this.busy = true; this.setMsg('Joining lobby…');
    try {
      const conn = this.ensureConn();
      const m = await conn.joinLobby(code, {
        name: this.form.name.trim() || 'Player',
        starter: this.form.starter,
        character: this.form.character,
      });
      this.enter(m);
    } catch (err) {
      this.busy = false;
      this.setMsg(err.code === 'NO_LOBBY' ? 'No lobby found with that code.' : (err.message || 'Could not join.'), true);
    }
  }

  async doResume(identity) {
    if (this.busy) return;
    this.busy = true; this.setMsg(`Resuming game ${identity.code}…`);
    try {
      const conn = this.ensureConn();
      const m = await conn.resume(identity.code, identity.playerId, identity.secret);
      this.enter(m);
    } catch (err) {
      this.busy = false;
      if (err.code === 'AUTH_FAILED') { forgetIdentity(identity.code); this.setMsg('That saved game is no longer available.', true); }
      else this.setMsg(err.message || 'Could not resume. Is the server running?', true);
    }
  }

  enter(m) {
    this.busy = false;
    this.onEnterGame(this.conn, m.config, m.save);
  }

  // ---- sub-renderers -----------------------------------------------------
  starterPicker() {
    return el('div', { class: 'lb-starters' }, this.world.progression.starters.map((sid) => {
      const sp = this.dex.getSpecies(sid);
      const sel = this.form.starter === sid;
      return el('button', {
        class: `lb-starter${sel ? ' sel' : ''}`, type: 'button',
        onclick: () => { this.form.starter = sid; this.render(); },
      }, [
        el('img', { src: spriteFront(sp.num), alt: sp.name }),
        el('span', { text: sp.name }),
      ]);
    }));
  }

  characterPicker() {
    return el('div', { class: 'lb-chars' }, CHARACTERS.map((c) => {
      const sel = this.form.character === c.id;
      return el('button', {
        class: `lb-char${sel ? ' sel' : ''}`, type: 'button', title: c.name,
        style: `--ring:${c.color}`,
        onclick: () => { this.form.character = c.id; this.render(); },
      }, [
        el('span', { class: 'lb-char-sprite', style: `--sheet:url("${new URL(`assets/characters/${c.id}.png`, document.baseURI).href}")` }),
      ]);
    }));
  }

  // "Player character" block: name input with the character skins underneath.
  playerSection() {
    return [
      el('h3', { class: 'lb-h', text: 'Player character' }),
      this.nameField(),
      this.characterPicker(),
    ];
  }

  nameField() {
    return el('label', { class: 'lb-field' }, [
      el('span', { text: 'Name' }),
      el('input', {
        class: 'lb-input', type: 'text', maxlength: 20, placeholder: 'Player',
        value: this.form.name,
        oninput: (e) => { this.form.name = e.target.value; },
      }),
    ]);
  }

  // Poké Ball amount: a 5–99 slider whose final notch (100) means unlimited.
  ballPicker() {
    const cur = this.form.ballAllowance;
    const sliderVal = cur === 'infinite' ? 100 : cur;
    const labelFor = (v) => (v === 'infinite' ? '∞ Unlimited' : `${v} per map`);
    const valEl = el('span', { class: 'lb-slider-val', text: labelFor(cur) });
    const slider = el('input', {
      class: 'lb-slider', type: 'range', min: 5, max: 100, step: 1, value: sliderVal,
      oninput: (e) => {
        const n = parseInt(e.target.value, 10);
        this.form.ballAllowance = n >= 100 ? 'infinite' : n;
        valEl.textContent = labelFor(this.form.ballAllowance); // live update, keep slider focus
      },
    });
    return el('div', { class: 'lb-slider-row' }, [slider, valEl]);
  }

  // ---- views -------------------------------------------------------------
  renderHome() {
    const recents = recentIdentities();
    const kids = [
      el('h1', { class: 'lb-title', text: 'PokéWeek' }),
      el('p', { class: 'lb-tag', text: 'Catch, train, and battle your friends across a week of routes.' }),
    ];

    if (recents.length) {
      kids.push(el('h3', { class: 'lb-h', text: 'Resume a game' }));
      kids.push(el('div', { class: 'lb-resumes' }, recents.map((id) => el('div', { class: 'lb-resume' }, [
        el('div', { class: 'lb-resume-info' }, [
          el('span', { class: 'lb-resume-code', text: `#${id.code}` }),
          el('span', { class: 'lb-resume-name', text: id.name || 'Player' }),
        ]),
        el('button', { class: 'primary sm', type: 'button', text: 'Resume', onclick: () => this.doResume(id) }),
        el('button', { class: 'ghost sm', type: 'button', text: '✕', title: 'Forget', onclick: () => { forgetIdentity(id.code); this.render(); } }),
      ]))));
    }

    kids.push(el('div', { class: 'lb-cta' }, [
      el('button', { class: 'primary', type: 'button', text: '＋ Create Lobby', onclick: () => { this.view = 'create'; this.msg = ''; this.render(); } }),
      el('button', { class: 'secondary', type: 'button', text: '→ Join by Code', onclick: () => { this.view = 'join'; this.msg = ''; this.render(); } }),
    ]));
    return kids;
  }

  renderCreate() {
    const isWeek = this.form.mode === 'week';
    const modeBtn = (id, label, sub) => el('button', {
      class: `lb-mode${this.form.mode === id ? ' sel' : ''}`, type: 'button',
      onclick: () => { this.form.mode = id; this.render(); },
    }, [el('b', { text: label }), el('span', { text: sub })]);

    return [
      el('div', { class: 'lb-head' }, [
        el('button', { class: 'ghost sm', type: 'button', text: '← Back', onclick: () => { this.view = 'home'; this.msg = ''; this.render(); } }),
        el('h2', { text: 'Create Lobby' }),
      ]),
      el('h3', { class: 'lb-h', text: 'Mode' }),
      el('div', { class: 'lb-modes' }, [
        modeBtn('free', 'Free play', 'All routes open, come & go'),
        modeBtn('week', '1-Week', 'One route unlocks per day'),
      ]),
      isWeek ? el('h3', { class: 'lb-h', text: 'Day length' }) : null,
      isWeek ? el('div', { class: 'lb-balls' }, DAY_PRESETS.map((d) => el('button', {
        class: `lb-pill${this.form.dayLength === d.id ? ' sel' : ''}`, type: 'button',
        onclick: () => { this.form.dayLength = d.id; this.render(); },
      }, [el('b', { text: d.label }), el('span', { text: ` · ${d.sub}` })]))) : null,
      el('h3', { class: 'lb-h', text: 'Poké Ball amount' }),
      this.ballPicker(),
      ...this.playerSection(),
      el('h3', { class: 'lb-h', text: 'Choose your starter' }),
      this.starterPicker(),
      el('div', { class: 'lb-cta' }, [
        el('button', { class: 'primary', type: 'button', text: this.busy ? 'Creating…' : 'Create & Start', disabled: this.busy, onclick: () => this.doCreate() }),
      ]),
    ];
  }

  renderJoin() {
    return [
      el('div', { class: 'lb-head' }, [
        el('button', { class: 'ghost sm', type: 'button', text: '← Back', onclick: () => { this.view = 'home'; this.msg = ''; this.render(); } }),
        el('h2', { text: 'Join Lobby' }),
      ]),
      el('label', { class: 'lb-field' }, [
        el('span', { text: 'Lobby code' }),
        el('input', {
          class: 'lb-input lb-code', type: 'text', inputmode: 'numeric', maxlength: 6, placeholder: '000000',
          value: this.form.code || '',
          oninput: (e) => { e.target.value = e.target.value.replace(/\D/g, '').slice(0, 6); this.form.code = e.target.value; },
        }),
      ]),
      ...this.playerSection(),
      el('h3', { class: 'lb-h', text: 'Choose your starter' }),
      this.starterPicker(),
      el('div', { class: 'lb-cta' }, [
        el('button', { class: 'primary', type: 'button', text: this.busy ? 'Joining…' : 'Join & Start', disabled: this.busy, onclick: () => this.doJoin() }),
      ]),
    ];
  }

  render() {
    let body;
    if (this.view === 'create') body = this.renderCreate();
    else if (this.view === 'join') body = this.renderJoin();
    else body = this.renderHome();

    const panel = el('div', { class: 'panel lobby-panel' }, [
      ...body,
      this.msg ? el('div', { class: `lb-msg${this.msgIsError ? ' err' : ''}`, text: this.msg }) : null,
    ]);
    this.root.innerHTML = '';
    this.root.append(panel);
  }
}
