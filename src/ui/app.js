// Top-level controller: load Gen 2 data, show the Battle Test Lab, and switch
// between the team-builder setup, a local battle, and online matchmaking.
import { loadDex } from './data.js';
import { loadWorld } from './world.js';
import { TeamBuilder } from './builder.js';
import { BattleView } from './battle.js';
import { connect, NetworkBattleView } from './net.js';
import { GameController, createGameState, gameStateFromSave } from './game.js';
import { LobbyScreen } from './lobby.js';
import { LobbyConnection, loadIdentities, forgetIdentity, setActiveLobby, getActiveLobby, clearActiveLobby } from './lobbynet.js';

const appEl = document.getElementById('app');

function mount(node) {
  appEl.innerHTML = '';
  appEl.append(node);
  window.scrollTo(0, 0);
}

async function main() {
  let dex;
  try {
    dex = await loadDex();
  } catch (err) {
    appEl.innerHTML = `<div class="loading">Failed to load data: ${err.message}<br><br>Run <b>npm run serve</b> and open http://localhost:8080/</div>`;
    return;
  }
  let world = null; // lazily loaded the first time the overworld is opened

  // The PokéWeek lobby is the real entry point (Task 16): create or join a
  // persistent online game by 6-digit code, or resume a saved one. Booting the
  // game hands the live connection to the GameController for save-sync.
  const showLobby = async () => {
    try {
      if (!world) world = await loadWorld();
    } catch (err) {
      mount(Object.assign(document.createElement('div'), { className: 'loading', textContent: 'World data failed: ' + err.message + ' — run "npm run build:world".' }));
      return;
    }
    const lobby = new LobbyScreen(dex, world, { onEnterGame: (conn, config, save) => enterGame(conn, config, save) });
    mount(lobby.root);
  };

  // Boot the overworld game wired to a live lobby connection. Every meaningful
  // state change persists through the connection to saves/<code>.json.
  const enterGame = (conn, config, save) => {
    // Mark this as the active lobby so a refresh / re-open auto-resumes it
    // (the single funnel for create, join, and resume-from-list).
    setActiveLobby(config.code);
    const state = gameStateFromSave(world, config, save);
    state.lobbyCode = config.code;
    const game = new GameController(dex, world, state, {
      conn,
      // ↩ Leave is the only way out: it forgets the active lobby so the home
      // screen (and its Resume list) is shown instead of bouncing back in.
      onExit: () => { clearActiveLobby(); conn.leave(); showLobby(); },
      onSave: (s, immediate) => { if (immediate) conn.saveNow(s); else conn.saveState(s); },
    });
    window.__game = game; // dev aid for the preview
    mount(game.start());
  };

  // On boot, if the player is already in a lobby, silently reconnect and drop
  // straight back into the game. Falls back to the lobby home on any failure
  // (and forgets the lobby only when the server says the identity is invalid).
  const resumeActiveLobby = async (code) => {
    const id = loadIdentities()[code];
    if (!id || !id.secret) { clearActiveLobby(); return false; }
    try {
      if (!world) world = await loadWorld();
    } catch (err) {
      mount(Object.assign(document.createElement('div'), { className: 'loading', textContent: 'World data failed: ' + err.message + ' — run "npm run build:world".' }));
      return true; // handled (showed an error) — don't fall through to the lobby
    }
    const conn = new LobbyConnection();
    try {
      const m = await conn.resume(code, id.playerId, id.secret);
      enterGame(conn, m.config, m.save);
      return true;
    } catch (err) {
      conn.close();
      // A durable rejection (lobby gone / bad secret) — drop the dead identity
      // so it leaves the Resume list, same as the lobby's manual resume does.
      // A transient failure (server down) surfaces as a timeout, not AUTH_FAILED,
      // so we keep the identity and just fall back to the lobby home.
      if (err && err.code === 'AUTH_FAILED') { forgetIdentity(code); clearActiveLobby(); }
      return false; // fall back to the lobby home
    }
  };

  const showSetup = () => {
    const builder = new TeamBuilder(dex, (config) => start(config));
    const owBtn = document.createElement('button');
    owBtn.className = 'secondary';
    owBtn.textContent = '🌍 Overworld (preview)';
    owBtn.addEventListener('click', () => startOverworld());
    const lobbyBtn = document.createElement('button');
    lobbyBtn.className = 'primary';
    lobbyBtn.textContent = '🌐 PokéWeek Lobby';
    lobbyBtn.addEventListener('click', () => showLobby());
    const bar = document.createElement('div');
    bar.style.cssText = 'width:min(880px,96vw);margin:10px auto 0;display:flex;gap:10px;justify-content:center';
    bar.append(lobbyBtn, owBtn);
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;flex:1';
    wrap.append(bar, builder.render());
    mount(wrap);
  };

  // Temporary overworld launcher. The real entry point is the lobby (Task 16);
  // this lets the overworld + wild-encounter systems be tested standalone with
  // a fresh local game state (default starter, 25 Poké Balls).
  const startOverworld = async () => {
    try {
      if (!world) world = await loadWorld();
    } catch (err) {
      mount(Object.assign(document.createElement('div'), { className: 'loading', textContent: 'World data failed: ' + err.message + ' — run "npm run build:world".' }));
      return;
    }
    const state = createGameState(dex, world, { name: 'You', encounterAllowance: 10, starterLevel: 8 });
    const game = new GameController(dex, world, state, { onExit: () => showSetup() });
    window.__game = game; // dev aid for the preview
    mount(game.start());
  };

  const start = (config) => {
    if (config.kind === 'online') startOnline(config);
    else startLocal(config);
  };

  const startLocal = (config) => {
    const view = new BattleView(dex, config, () => showSetup());
    mount(view.root);
    view.run();
  };

  const startOnline = (config) => {
    const wsUrl = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host + location.pathname.replace(/[^/]*$/, '');
    let conn;
    let matched = false;

    // Matchmaking / connection screen.
    const status = document.createElement('div');
    status.className = 'mm-status';
    status.textContent = 'Connecting to server…';
    const cancel = document.createElement('button');
    cancel.className = 'secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { try { conn && conn.ws.close(); } catch { /* ignore */ } showSetup(); });
    const panel = document.createElement('div');
    panel.className = 'panel matchmaking';
    const h = document.createElement('h2'); h.textContent = 'Online PvP';
    const spinner = document.createElement('div'); spinner.className = 'mm-spinner';
    panel.append(h, spinner, status, cancel);
    const wrap = document.createElement('div'); wrap.className = 'mm-wrap';
    wrap.append(panel);
    mount(wrap);

    const setStatus = (text, isError) => { status.textContent = text; status.classList.toggle('err', !!isError); };

    try {
      conn = connect(wsUrl);
    } catch (err) {
      setStatus('Could not connect. Start the server with "npm run server".', true);
      return;
    }

    conn.onOpen = () => {
      setStatus('Searching for an opponent…');
      conn.send({ t: 'queue', name: config.names[0], team: config.teams[0] });
    };

    conn.onMessage = (m) => {
      if (m.t === 'queued') {
        setStatus('In queue — waiting for another player to search…');
      } else if (m.t === 'matched') {
        matched = true;
        const view = new NetworkBattleView(dex, conn, () => showSetup());
        mount(view.root);
        view.begin(m); // hands the connection over to the battle view
      } else if (m.t === 'error') {
        setStatus(m.msg || 'Server error.', true);
      }
    };

    conn.onClose = () => {
      if (matched) return; // the battle view owns the socket now
      setStatus('Disconnected. Start the server with "npm run server", then reload.', true);
    };
  };

  const active = getActiveLobby();
  if (active && await resumeActiveLobby(active)) return;
  showLobby();
}

main();
