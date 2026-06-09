// Poké Mart overlay: buy the current map's items, organized into tabs by type
// (Balls, Stones, Vitamins, Candy, TMs, HMs). Great Balls land in the ball
// pouch; everything else goes to the bag. Re-renders after each purchase so
// money totals and "owned" counts stay live. Pure view — the GameController
// owns the economy (buyItem / ownedCount / martInventory).

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

// Tabs in display order; each groups one or more item kinds. Only tabs with
// items in stock are shown.
const TAB_DEFS = [
  { id: 'usables', label: 'Usables', kinds: ['ball', 'levelup', 'statboost'] },
  { id: 'stones', label: 'Stones', kinds: ['stone'] },
  { id: 'tms', label: 'TMs', kinds: ['tm'] },
];
const KIND_LABEL = { ball: 'Poké Ball', statboost: 'Vitamin', levelup: 'Level up', stone: 'Evolution', tm: 'TM' };
const yen = (n) => `₽${Number(n).toLocaleString('en-US')}`;

export class MartView {
  constructor(game, onClose) {
    this.game = game;
    this.onClose = onClose || (() => {});
    this.msg = '';
    this.tab = null; // set to the first available tab on first render
    this.root = el('div', { class: 'ow-overlay mart-overlay', onclick: (e) => { if (e.target === this.root) this.close(); } });
    this.render();
  }

  close() { this.onClose(); }

  // Subtitle under an item name: move info for TMs, else the kind label.
  subtitle(item) {
    if (item.kind === 'tm') {
      const mv = this.game.dex.getMove(item.move);
      const power = mv.basePower ? ` · ${mv.basePower} BP` : (mv.category === 'Status' ? ' · Status' : '');
      return `${mv.type}${power}`;
    }
    return KIND_LABEL[item.kind] || item.kind;
  }

  // Names of party members that can learn this TM's move (empty for non-TMs).
  compatibleMons(item) {
    if (item.kind !== 'tm' || !item.move) return [];
    return (this.game.state.party || [])
      .filter((mon) => (this.game.dex.getLearnset(mon.species).machine || []).includes(item.move))
      .map((mon) => this.game.monName(mon));
  }

  render() {
    const g = this.game;
    const inv = g.martInventory();
    const money = g.state.money || 0;

    const tabs = TAB_DEFS.filter((t) => inv.some((it) => t.kinds.includes(it.kind)));
    if (!tabs.some((t) => t.id === this.tab)) this.tab = tabs.length ? tabs[0].id : null;
    const active = tabs.find((t) => t.id === this.tab) || tabs[0];
    const tabBar = el('div', { class: 'mart-tabs' }, tabs.map((t) => el('button', {
      class: `mart-tab${this.tab === t.id ? ' sel' : ''}`,
      text: `${t.label} (${inv.filter((it) => t.kinds.includes(it.kind)).length})`,
      onclick: () => { this.tab = t.id; this.render(); },
    })));

    const rows = inv.filter((it) => active && active.kinds.includes(it.kind)).map((item) => {
      const owned = g.ownedCount(item);
      const afford = money >= item.price;
      const compat = this.compatibleMons(item);
      return el('div', { class: 'mart-row' }, [
        el('span', { class: `mart-ico mk-${item.kind}` }),
        el('div', { class: 'mart-info' }, [
          el('span', { class: 'mart-name', text: item.name }),
          el('span', { class: 'mart-kind', text: this.subtitle(item) }),
          compat.length ? el('span', { class: 'mart-compat', text: `✓ ${compat.join(', ')}` }) : null,
        ]),
        el('span', { class: 'mart-owned', text: owned ? `×${owned}` : '' }),
        el('span', { class: 'mart-price', text: yen(item.price) }),
        el('button', { class: 'primary mart-buy', text: 'Buy', disabled: !afford, onclick: () => this.buy(item) }),
      ]);
    });

    const panel = el('div', { class: 'panel mart-panel' }, [
      el('div', { class: 'mart-head' }, [
        el('h3', { text: '🛒 Poké Mart' }),
        el('span', { class: 'mart-wallet', text: yen(money) }),
        el('button', { class: 'ghost', text: '✕', onclick: () => this.close() }),
      ]),
      tabBar,
      el('div', { class: 'mart-list' }, rows.length ? rows : [el('div', { class: 'menu-empty', text: 'Nothing here yet.' })]),
      el('div', { class: 'mart-msg', text: this.msg || 'Welcome! What would you like to buy?' }),
    ]);

    this.root.innerHTML = '';
    this.root.append(panel);
  }

  buy(item) {
    const res = this.game.buyItem(item);
    this.msg = res.msg;
    this.render();
  }
}
