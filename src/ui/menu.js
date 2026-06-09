// In-overworld menu overlay: manage the party (up to 6) and PC box, view a
// Pokémon summary (stats + moves), and use bag items (vitamins, Rare Candy,
// evolution stones) on a chosen party member. Pure view — the GameController
// owns the rules (useItem / movePartyToBox / moveBoxToParty / monStats).
import { spriteFront, TYPE_COLORS } from './data.js';

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

const STAT_ORDER = ['hp', 'atk', 'def', 'spa', 'spd', 'spe'];
const STAT_LABEL = { hp: 'HP', atk: 'Atk', def: 'Def', spa: 'SpA', spd: 'SpD', spe: 'Spe' };
const yen = (n) => `₽${Number(n).toLocaleString('en-US')}`;

export class PartyMenu {
  // tab: 'box'  → manage party ↔ PC box (transfers + summaries)
  //      'items'→ use bag items on a party member
  constructor(game, onClose, opts = {}) {
    this.game = game;
    this.onClose = onClose || (() => {});
    this.tab = opts.tab || 'box';
    this.msg = '';
    this.useItemId = null;   // when set, the menu is in "pick a target" mode
    this.teach = null;       // { id, monIndex, item } — pick a move to forget
    this.evPick = null;      // { stat, monIndex, amount, max } — candy amount picker
    this.dragCandy = null;   // stat currently being dragged
    this.candySel = null;    // stat selected by click (drag-free fallback)
    this.summaryKey = null;  // 'p:<i>' | 'b:<i>' — which card's summary is open
    this.root = el('div', { class: 'ow-overlay menu-overlay', onclick: (e) => { if (e.target === this.root) this.close(); } });
    this.render();
  }

  close() { this.onClose(); }

  // ---- a single Pokémon card --------------------------------------------
  monCard(mon, where, i) {
    const g = this.game;
    const species = g.dex.getSpecies(mon.species);
    const cap = g.mapCap();
    const capped = mon.level > cap;
    const key = `${where}:${i}`;
    const open = this.summaryKey === key;

    const types = el('span', { class: 'mn-types' }, species.types.map((t) =>
      el('span', { class: 'typechip sm', text: t, style: `background:${TYPE_COLORS[t] || '#888'}` })));

    const actions = [];
    if (this.useItemId != null && where === 'p') {
      const item = g.itemDef(this.useItemId);
      const isTM = ['tm', 'hm'].includes(item.kind);
      if (isTM) {
        // Only Pokémon whose learnset includes the move can be taught it. Show
        // why the rest are unavailable rather than offering a dead "Teach".
        const chk = g.tmLearnable(mon, item);
        const knows = (mon.moves || []).includes(item.move);
        actions.push(el('button', {
          class: 'primary sm', disabled: !chk.ok,
          text: chk.ok ? 'Teach' : (knows ? 'Knows it' : "Can't learn"),
          onclick: () => this.applyUse(i),
        }));
      } else {
        actions.push(el('button', { class: 'primary sm', text: 'Use here', onclick: () => this.applyUse(i) }));
      }
    } else {
      actions.push(el('button', { class: 'ghost sm', text: 'Summary', onclick: () => g.showMonSummary(mon) }));
      if (where === 'p') actions.push(el('button', { class: 'secondary sm', text: '→ Box', onclick: () => this.act(g.movePartyToBox(i)) }));
      else actions.push(el('button', { class: 'secondary sm', text: '→ Party', onclick: () => this.act(g.moveBoxToParty(i)) }));
    }

    const card = el('div', { class: `mn-card${mon.shiny ? ' shiny' : ''}${where === 'b' ? ' has-release' : ''}` }, [
      // PC Box cards get a left-side red X to release (permanently delete) the mon.
      where === 'b' ? el('button', { class: 'mn-release', title: `Release ${g.monName(mon)}`, text: '✕', onclick: () => this.releaseNow(i) }) : null,
      el('img', { class: 'mn-sprite', src: spriteFront(species.num, mon.shiny), alt: species.name }),
      el('div', { class: 'mn-meta' }, [
        el('span', { class: 'mn-name', text: `${g.monName(mon)}${mon.shiny ? ' ✦' : ''}` }),
        el('span', { class: 'mn-lv', text: `Lv ${mon.level}${capped ? ` (▼${cap})` : ''}` }),
        types,
      ]),
      el('div', { class: 'mn-actions' }, actions),
    ]);

    if (open) card.append(this.summary(mon, capped ? cap : mon.level));
    return card;
  }

  // ---- stats + moves summary --------------------------------------------
  summary(mon, level) {
    const g = this.game;
    const stats = g.monStats(mon, level);
    const statGrid = el('div', { class: 'mn-stats' }, STAT_ORDER.map((k) =>
      el('span', { class: 'mn-stat' }, [
        el('b', { text: STAT_LABEL[k] }), el('span', { text: ` ${stats[k]}` }),
      ])));
    const moves = el('div', { class: 'mn-moves' }, (mon.moves || []).map((mid) => {
      const mv = g.dex.getMove(mid);
      const color = TYPE_COLORS[mv.type] || '#888';
      return el('span', { class: 'mn-move', style: `border-left:6px solid ${color}`, text: mv.name });
    }));
    return el('div', { class: 'mn-summary' }, [
      el('div', { class: 'mn-summary-h', text: `Stats @ Lv ${level}` }),
      statGrid,
      el('div', { class: 'mn-summary-h', text: 'Moves' }),
      moves,
    ]);
  }

  act(res) { this.msg = res.msg; this.summaryKey = null; this.render(); }

  applyUse(monIndex) {
    const g = this.game;
    const item = g.itemDef(this.useItemId);
    if (item.kind === 'tm' || item.kind === 'hm') return this.tryTeach(monIndex, item);
    const res = g.useItem(this.useItemId, monIndex);
    this.msg = res.msg;
    if (res.ok || (g.state.bag[this.useItemId] || 0) <= 0) this.useItemId = null;
    this.render();
    // A Rare Candy can push the mon past a move-learn level with 4 moves already;
    // drain the keep/replace prompts, then refresh the menu to show new moves.
    if (g.pendingLearns && g.pendingLearns.length) g.processLearnQueue().then(() => this.render());
  }

  // TM/HM: if the mon can learn it and has room, teach now; if it already knows
  // 4 moves, drop into the "forget a move" picker.
  tryTeach(monIndex, item) {
    const g = this.game;
    const mon = g.state.party[monIndex];
    const chk = g.tmLearnable(mon, item);
    if (!chk.ok) { this.msg = chk.msg; this.render(); return; }
    if ((mon.moves || []).length < 4) {
      const res = g.teachMove(this.useItemId, monIndex);
      this.msg = res.msg;
      if (!item.reusable && (g.state.bag[this.useItemId] || 0) <= 0) this.useItemId = null;
      this.render();
    } else {
      this.teach = { id: this.useItemId, monIndex, item };
      this.render();
    }
  }

  doTeach(replaceIndex) {
    const g = this.game, t = this.teach;
    const res = g.teachMove(t.id, t.monIndex, replaceIndex);
    this.msg = res.msg;
    this.teach = null;
    if (!t.item.reusable && (g.state.bag[t.id] || 0) <= 0) this.useItemId = null;
    this.render();
  }

  // Release: a box card's red X releases that Pokémon immediately.
  releaseNow(i) { this.act(this.game.releaseFromBox(i)); }

  // ---- EV candies -------------------------------------------------------
  // A party member as a candy drop target (drag a candy in, or click-then-tap).
  candyTarget(mon, i) {
    const g = this.game;
    const sp = g.dex.getSpecies(mon.species);
    const evTotal = STAT_ORDER.reduce((s, k) => s + ((mon.evs && mon.evs[k]) || 0), 0);
    return el('div', {
      class: `candy-target${this.candySel ? ' armed' : ''}`,
      ondragover: (e) => { if (this.dragCandy) { e.preventDefault(); e.currentTarget.classList.add('over'); } },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => { if (this.dragCandy) { e.preventDefault(); const s = this.dragCandy; this.dragCandy = null; this.openEvPick(s, i); } },
      onclick: () => { if (this.candySel) this.openEvPick(this.candySel, i); },
    }, [
      el('img', { class: 'ct-sprite', src: spriteFront(sp.num, mon.shiny), alt: sp.name, draggable: 'false' }),
      el('div', { class: 'ct-info' }, [
        el('span', { class: 'ct-name', text: g.monName(mon) }),
        el('span', { class: 'ct-ev', text: `EV ${evTotal}/510` }),
      ]),
    ]);
  }

  // Open the "how many candies?" amount picker for a stat on party[monIndex].
  openEvPick(stat, monIndex) {
    const g = this.game;
    const max = g.candyRoom(monIndex, stat);
    this.candySel = null; this.dragCandy = null;
    if (max <= 0) { this.msg = `${g.monName(g.state.party[monIndex])} can't gain more ${STAT_LABEL[stat]} EVs.`; this.render(); return; }
    this.evPick = { stat, monIndex, amount: max, max };
    this.render();
  }

  doEv() {
    const p = this.evPick;
    const res = this.game.applyCandies(p.monIndex, p.stat, p.amount);
    this.msg = res.msg;
    this.evPick = null;
    this.render();
  }

  render() {
    const g = this.game;
    const party = g.state.party;
    const box = g.state.box;
    const sections = [];
    const title = this.tab === 'items' ? '🎒 Items' : '💻 PC Box';

    if (this.tab === 'items') {
      if (this.evPick) {
        // amount picker for EV candies (after a drag-drop / tap onto a mon)
        const p = this.evPick;
        const mon = g.state.party[p.monIndex];
        const cur = (mon.evs && mon.evs[p.stat]) || 0;
        sections.push(el('div', { class: 'menu-usebar' }, [
          el('span', { text: `${STAT_LABEL[p.stat]} candies → ${g.monName(mon)}` }),
          el('button', { class: 'ghost sm', text: 'Cancel', onclick: () => { this.evPick = null; this.render(); } }),
        ]));
        const valEl = el('span', { class: 'evpick-val', text: `${p.amount}` });
        const prev = el('span', { class: 'evpick-preview', text: `${STAT_LABEL[p.stat]} EV  ${cur} → ${cur + p.amount}` });
        const slider = el('input', {
          class: 'evpick-slider', type: 'range', min: 1, max: p.max, step: 1, value: p.amount,
          oninput: (e) => { p.amount = parseInt(e.target.value, 10); valEl.textContent = `${p.amount}`; prev.textContent = `${STAT_LABEL[p.stat]} EV  ${cur} → ${cur + p.amount}`; },
        });
        sections.push(el('div', { class: 'evpick' }, [
          el('div', { class: 'evpick-row' }, [slider, valEl]),
          prev,
          el('button', { class: 'primary', text: 'Apply', onclick: () => this.doEv() }),
        ]));
      } else if (this.teach) {
        // move-replacement picker: the mon knows 4 moves, choose one to forget
        const mon = g.state.party[this.teach.monIndex];
        const newMv = g.dex.getMove(this.teach.item.move);
        const meta = (mv) => `${mv.type}${mv.basePower ? ` · ${mv.basePower} BP` : ''}`;
        sections.push(el('div', { class: 'menu-usebar' }, [
          el('span', { text: `${g.monName(mon)} wants to learn ${newMv.name} — forget which move?` }),
          el('button', { class: 'ghost sm', text: 'Cancel', onclick: () => { this.teach = null; this.render(); } }),
        ]));
        sections.push(el('div', { class: 'teach-moves' }, (mon.moves || []).map((mid, i) => {
          const mv = g.dex.getMove(mid);
          return el('button', { class: 'teach-move', style: `border-left:6px solid ${TYPE_COLORS[mv.type] || '#888'}`, onclick: () => this.doTeach(i) }, [
            el('span', { class: 'tm-name', text: mv.name }), el('span', { class: 'tm-meta', text: meta(mv) }),
          ]);
        })));
        sections.push(el('div', { class: 'teach-new', text: `Learning: ${newMv.name} · ${meta(newMv)}` }));
      } else if (this.useItemId != null) {
        // target-picker mode: choose which party member receives the item
        const item = g.itemDef(this.useItemId);
        const isTM = item.kind === 'tm' || item.kind === 'hm';
        sections.push(el('div', { class: 'menu-usebar' }, [
          el('span', { text: isTM ? `Teach ${item.name} to which Pokémon?` : `Use ${item.name} on which Pokémon?` }),
          el('button', { class: 'ghost sm', text: 'Cancel', onclick: () => { this.useItemId = null; this.render(); } }),
        ]));
        sections.push(el('div', { class: 'mn-grid' }, party.map((m, i) => this.monCard(m, 'p', i))));
      } else {
        // EV candies (from wild defeats) — drag onto a team member to spend.
        const candies = g.state.candies || {};
        const candyStats = STAT_ORDER.filter((k) => (candies[k] || 0) > 0);
        sections.push(el('h4', { class: 'menu-sub', text: 'EV Candies' }));
        if (candyStats.length) {
          sections.push(el('div', { class: 'candy-list' }, candyStats.map((k) => el('div', {
            class: `candy-chip stat-${k}${this.candySel === k ? ' sel' : ''}`, draggable: 'true',
            title: `${STAT_LABEL[k]} candy ×${candies[k]} — drag onto a Pokémon`,
            ondragstart: (e) => { this.dragCandy = k; try { e.dataTransfer.setData('text/plain', k); e.dataTransfer.effectAllowed = 'copy'; } catch { /* ignore */ } },
            ondragend: () => { this.dragCandy = null; },
            onclick: () => { this.candySel = this.candySel === k ? null : k; this.render(); },
          }, [el('span', { class: 'candy-stat', text: STAT_LABEL[k] }), el('span', { class: 'candy-count', text: `×${candies[k]}` })])) ));
          sections.push(el('div', { class: 'candy-hint', text: this.candySel ? `Tap a Pokémon to use ${STAT_LABEL[this.candySel]} candies.` : 'Drag a candy onto a team member (or tap a candy, then a Pokémon).' }));
          sections.push(el('div', { class: 'candy-targets' }, party.map((m, i) => this.candyTarget(m, i))));
        } else {
          sections.push(el('div', { class: 'menu-empty', text: 'Defeat wild Pokémon to earn EV candies.' }));
        }

        const bag = g.bagEntries();
        sections.push(el('h4', { class: 'menu-sub', text: 'Bag' }));
        if (bag.length) {
          sections.push(el('div', { class: 'bag-list' }, bag.map(({ item, count }) => {
            const isTM = item.kind === 'tm' || item.kind === 'hm';
            return el('div', { class: 'bag-row' }, [
              el('span', { class: `mart-ico mk-${item.kind}` }),
              el('span', { class: 'bag-name', text: item.name }),
              el('span', { class: 'bag-count', text: item.reusable ? '∞' : `×${count}` }),
              el('button', { class: 'primary sm', text: isTM ? 'Teach' : 'Use', onclick: () => { this.useItemId = item.id; this.summaryKey = null; this.msg = ''; this.render(); } }),
            ]);
          })));
        } else {
          sections.push(el('div', { class: 'menu-empty', text: 'Your bag is empty. Buy items at the Poké Mart.' }));
        }
      }
    } else {
      // 'box' tab: party ↔ PC box transfers + summaries
      sections.push(el('h4', { class: 'menu-sub', text: `Party (${party.length}/${g.world.progression.teamSize})` }));
      sections.push(el('div', { class: 'mn-grid' }, party.map((m, i) => this.monCard(m, 'p', i))));
      sections.push(el('h4', { class: 'menu-sub', text: `PC Box (${box.length}/6)` }));
      sections.push(box.length
        ? el('div', { class: 'mn-grid' }, box.map((m, i) => this.monCard(m, 'b', i)))
        : el('div', { class: 'menu-empty', text: 'The PC Box is empty.' }));
    }

    const head = el('div', { class: 'menu-head' }, [
      el('h3', { text: title }),
      el('span', { class: 'menu-wallet', text: yen(g.state.money || 0) }),
      el('button', { class: 'ghost', text: '✕', onclick: () => this.close() }),
    ]);
    const panel = el('div', { class: 'panel menu-panel' }, [
      head,
      el('div', { class: 'menu-body' }, sections),
      el('div', { class: 'menu-msg', text: this.msg }),
    ]);

    this.root.innerHTML = '';
    this.root.append(panel);
  }
}
