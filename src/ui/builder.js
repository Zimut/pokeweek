// The Battle Test Lab setup screen: build two teams, choose a battle context,
// and apply PokeWeek "house rule" caps (max level + team size) before fighting.
import { spriteFront, TYPE_COLORS } from './data.js';

const el = (tag, props = {}, kids = []) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const c of [].concat(kids)) if (c != null) n.append(c);
  return n;
};

const CONTEXTS = {
  trainer: { label: 'vs Trainer (AI)', kind: 'trainer', controllers: ['human', 'ai'], p2size: null },
  wild:    { label: 'Wild Pokémon',    kind: 'wild',    controllers: ['human', 'ai'], p2size: 1 },
  pvp:     { label: 'PvP Hotseat (2P)', kind: 'pvp',    controllers: ['human', 'human'], p2size: null },
  online:  { label: 'Online PvP',      kind: 'online',  controllers: ['human', 'net'], p2size: 0 },
  watch:   { label: 'Watch (AI vs AI)', kind: 'trainer', controllers: ['ai', 'ai'], p2size: null },
};

export class TeamBuilder {
  constructor(dex, onStart) {
    this.dex = dex;
    this.onStart = onStart;
    this.species = dex.allSpecies();
    this.state = {
      context: 'trainer',
      levelCap: 50,
      teamCap: 3,
      teams: [[], []],
    };
    this.root = el('div');
    // seed each side with a sensible default team
    this.state.teams[0] = this.sampleTeam(3);
    this.state.teams[1] = this.sampleTeam(3);
  }

  // ---- helpers -----------------------------------------------------------
  ctx() { return CONTEXTS[this.state.context]; }
  effectiveTeamCap(side) {
    const p2 = this.ctx().p2size;
    if (side === 1 && p2 != null) return p2;
    return this.state.teamCap;
  }

  makeSlot(speciesId) {
    const lvl = this.state.levelCap;
    return { species: speciesId, level: lvl, moves: this.dex.defaultMoves(speciesId, lvl) };
  }

  sampleTeam(n) {
    const picks = [];
    const used = new Set();
    while (picks.length < n) {
      const s = this.species[Math.floor(Math.random() * this.species.length)];
      if (used.has(s.id)) continue;
      used.add(s.id);
      picks.push(this.makeSlot(s.id));
    }
    return picks;
  }

  clampSlotLevels() {
    for (const team of this.state.teams)
      for (const slot of team) {
        if (slot.level > this.state.levelCap) slot.level = this.state.levelCap;
        if (slot.level < 2) slot.level = 2;
        // prune now-illegal moves
        const legal = new Set(this.dex.legalMoves(slot.species, slot.level));
        slot.moves = slot.moves.filter((m) => legal.has(m));
        if (!slot.moves.length) slot.moves = this.dex.defaultMoves(slot.species, slot.level);
      }
  }

  // ---- top-level render --------------------------------------------------
  render() {
    this.root.innerHTML = '';
    this.root.append(this.renderTopbar(), this.renderSetup(), this.renderStartBar());
    return this.root;
  }

  renderTopbar() {
    return el('div', { class: 'topbar' }, [
      el('div', { class: 'logo', html: 'Poke<span>Week</span>' }),
      el('div', { class: 'sub', text: 'Battle Test Lab · Gen 2 engine' }),
    ]);
  }

  renderSetup() {
    const wrap = el('div', { class: 'setup' });
    wrap.append(this.renderRules());
    if (this.state.context === 'online') {
      wrap.append(this.renderTeamCol(0, 'Your Team'));
      wrap.append(this.renderOnlineNote());
      return wrap;
    }
    wrap.append(this.renderTeamCol(0, this.ctx().controllers[0] === 'human' ? 'Player 1' : 'AI (Side 1)'));
    const side2label = this.state.context === 'wild' ? 'Wild Pokémon'
      : this.ctx().controllers[1] === 'human' ? 'Player 2' : 'Opponent (AI)';
    wrap.append(this.renderTeamCol(1, side2label));
    return wrap;
  }

  renderOnlineNote() {
    return el('div', { class: 'team-col' }, [
      el('div', { class: 'panel online-note' }, [
        el('h2', { text: 'Online Opponent' }),
        el('p', { text: 'Your opponent brings their own team. Press Start Battle to enter matchmaking — you\'ll be paired with the next player who is also searching.' }),
        el('p', { class: 'hint', text: 'Requires the game server: run "npm run server" and open this page from the same address in two browsers (or share your LAN address with a friend).' }),
      ]),
    ]);
  }

  renderRules() {
    const panel = el('div', { class: 'panel rules' }, [el('h2', { text: 'House Rules' })]);

    // Context segmented control
    panel.append(el('div', { class: 'row' }, el('label', { text: 'Battle context' })));
    const seg = el('div', { class: 'seg' });
    for (const [key, c] of Object.entries(CONTEXTS)) {
      seg.append(el('button', {
        class: this.state.context === key ? 'on' : '',
        text: c.label,
        onclick: () => { this.state.context = key; this.render(); },
      }));
    }
    panel.append(seg);

    // Daily level cap
    const lvlInput = el('input', {
      type: 'number', min: 2, max: 100, value: this.state.levelCap,
      onchange: (e) => {
        this.state.levelCap = Math.max(2, Math.min(100, Number(e.target.value) || 50));
        this.clampSlotLevels();
        this.render();
      },
    });
    panel.append(el('div', { class: 'row' }, [el('label', { text: 'Daily level cap' }), lvlInput]));
    panel.append(el('div', { class: 'hint', text: 'Every Pokémon is capped at this level (PokeWeek daily rule).' }));

    // Team size cap
    const sizeSeg = el('div', { class: 'seg' });
    for (let n = 1; n <= 6; n++) {
      sizeSeg.append(el('button', {
        class: this.state.teamCap === n ? 'on' : '',
        text: String(n),
        onclick: () => { this.state.teamCap = n; this.trimTeams(); this.render(); },
      }));
    }
    panel.append(el('div', { class: 'row' }, el('label', { text: 'Team size cap' })));
    panel.append(sizeSeg);
    panel.append(el('div', { class: 'hint', text: 'Max party size per trainer. Wild battles are always 1.' }));

    return panel;
  }

  trimTeams() {
    for (let s = 0; s < 2; s++) {
      const cap = this.effectiveTeamCap(s);
      if (this.state.teams[s].length > cap) this.state.teams[s].length = cap;
    }
  }

  renderTeamCol(side, label) {
    const cap = this.effectiveTeamCap(side);
    const team = this.state.teams[side];
    if (team.length > cap) team.length = cap;

    const col = el('div', { class: 'team-col' });
    const head = el('div', { class: 'panel team-head' }, [
      el('h2', { text: label }),
      el('span', { class: 'count', text: `${team.length}/${cap}` }),
      el('button', { class: 'ghost', text: '🎲 Random', onclick: () => { this.state.teams[side] = this.sampleTeam(cap); this.render(); } }),
    ]);
    col.append(head);

    team.forEach((slot, i) => col.append(this.renderSlot(side, i, slot)));

    if (team.length < cap) {
      col.append(el('div', { class: 'panel add-slot' },
        el('button', { class: 'secondary', text: '+ Add Pokémon', onclick: () => this.openPicker(side) })));
    }
    return col;
  }

  renderSlot(side, idx, slot) {
    const sp = this.dex.getSpecies(slot.species);
    const portrait = el('img', { class: 'portrait', src: spriteFront(sp.num), alt: sp.name });

    const typechips = el('div', { class: 'typechips' },
      sp.types.map((t) => el('span', { class: 'typechip', text: t, style: `background:${TYPE_COLORS[t] || '#888'}` })));

    const lvlInput = el('input', {
      type: 'number', min: 2, max: this.state.levelCap, value: slot.level,
      onchange: (e) => {
        slot.level = Math.max(2, Math.min(this.state.levelCap, Number(e.target.value) || this.state.levelCap));
        const legal = new Set(this.dex.legalMoves(slot.species, slot.level));
        slot.moves = slot.moves.filter((m) => legal.has(m));
        if (!slot.moves.length) slot.moves = this.dex.defaultMoves(slot.species, slot.level);
        this.render();
      },
    });

    const line1 = el('div', { class: 'line1' }, [
      el('span', { class: 'name', text: sp.name }),
      typechips,
      el('span', { text: 'Lv', style: 'font-size:11px;margin-left:auto' }),
      lvlInput,
    ]);

    const legal = this.dex.legalMoves(slot.species, slot.level).slice().sort((a, b) =>
      this.dex.getMove(a).name.localeCompare(this.dex.getMove(b).name));
    const movesGrid = el('div', { class: 'moves' });
    for (let m = 0; m < 4; m++) {
      const sel = el('select', {
        onchange: (e) => { slot.moves[m] = e.target.value || undefined; slot.moves = slot.moves.filter(Boolean); this.render(); },
      });
      sel.append(el('option', { value: '', text: '— empty —' }));
      for (const id of legal) {
        const mv = this.dex.getMove(id);
        const opt = el('option', { value: id, text: `${mv.name} (${mv.type}${mv.basePower ? ' ' + mv.basePower : ''})` });
        if (slot.moves[m] === id) opt.selected = true;
        sel.append(opt);
      }
      movesGrid.append(sel);
    }

    const btns = el('div', { class: 'slotbtns' }, [
      el('button', { text: 'Auto moves', onclick: () => { slot.moves = this.dex.defaultMoves(slot.species, slot.level); this.render(); } }),
      el('button', { text: 'Swap', onclick: () => this.openPicker(side, idx) }),
      el('button', { class: 'ghost', text: '✕', onclick: () => { this.state.teams[side].splice(idx, 1); this.render(); } }),
    ]);

    const meta = el('div', { class: 'meta' }, [line1, movesGrid, btns]);
    return el('div', { class: 'panel slot' }, [portrait, meta]);
  }

  // ---- species picker ----------------------------------------------------
  openPicker(side, replaceIdx = null) {
    const bg = el('div', { class: 'modal-bg', onclick: (e) => { if (e.target === bg) bg.remove(); } });
    const search = el('input', { placeholder: 'Search by name or #…', autofocus: true });
    const grid = el('div', { class: 'grid' });

    const fill = (q) => {
      grid.innerHTML = '';
      const ql = q.trim().toLowerCase();
      for (const sp of this.species) {
        if (ql && !sp.name.toLowerCase().includes(ql) && String(sp.num) !== ql) continue;
        grid.append(el('div', {
          class: 'dexcell',
          onclick: () => {
            const newSlot = this.makeSlot(sp.id);
            if (replaceIdx != null) this.state.teams[side][replaceIdx] = newSlot;
            else this.state.teams[side].push(newSlot);
            bg.remove();
            this.render();
          },
        }, [
          el('img', { src: spriteFront(sp.num), alt: sp.name, loading: 'lazy' }),
          el('span', { class: 'dexnum', text: '#' + String(sp.num).padStart(3, '0') }),
          el('span', { class: 'dexname', text: sp.name }),
        ]));
      }
    };
    search.addEventListener('input', () => fill(search.value));
    fill('');

    const picker = el('div', { class: 'panel picker' }, [
      el('div', { class: 'pickhead' }, [
        el('h3', { text: replaceIdx != null ? 'Swap Pokémon' : 'Choose a Pokémon', style: 'margin:0' }),
        search,
        el('button', { class: 'ghost', text: 'Close', onclick: () => bg.remove() }),
      ]),
      grid,
    ]);
    bg.append(picker);
    document.body.append(bg);
    setTimeout(() => search.focus(), 30);
  }

  // ---- start bar ---------------------------------------------------------
  renderStartBar() {
    const errSpan = el('div', { class: 'err' });
    const startBtn = el('button', { class: 'primary', text: '▶ Start Battle' });
    const bar = el('div', { class: 'start-bar' }, [errSpan, startBtn]);

    startBtn.addEventListener('click', () => {
      const err = this.validate();
      if (err) { errSpan.textContent = err; return; }
      const ctx = this.ctx();
      const online = ctx.kind === 'online';
      this.onStart({
        kind: ctx.kind,
        controllers: ctx.controllers,
        names: this.sideNames(),
        teams: online ? [this.exportTeam(0), []] : [this.exportTeam(0), this.exportTeam(1)],
      });
    });
    return bar;
  }

  sideNames() {
    const c = this.state.context;
    if (c === 'wild') return ['You', 'Wild'];
    if (c === 'pvp') return ['Player 1', 'Player 2'];
    if (c === 'online') return ['You', 'Opponent'];
    if (c === 'watch') return ['Red (AI)', 'Blue (AI)'];
    return ['You', 'Rival'];
  }

  exportTeam(side) {
    return this.state.teams[side].map((s) => ({
      species: s.species,
      level: s.level,
      moves: (s.moves && s.moves.length) ? s.moves.slice(0, 4) : this.dex.defaultMoves(s.species, s.level),
    }));
  }

  validate() {
    // Online battles only validate your own team; the opponent brings theirs.
    const sides = this.state.context === 'online' ? [0] : [0, 1];
    for (const s of sides) {
      const team = this.state.teams[s];
      if (!team.length) return `Side ${s + 1} needs at least one Pokémon.`;
      for (const slot of team) {
        const moves = (slot.moves || []).filter(Boolean);
        if (!moves.length) return `${this.dex.getSpecies(slot.species).name} needs at least one move.`;
      }
    }
    return null;
  }
}
